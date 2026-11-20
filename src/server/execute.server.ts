import pg from 'pg'
import { firstKeyword, splitStatements } from '@/lib/sql'
import type { Cell, ExecuteResult, ExplainResult, ExplainUnavailable, JsonValue, StatementResult } from '@/lib/types'
import { readStatement } from './data.server'
import { connectConfig, isPgError, pgErrorInfo, poolFor, watchClient } from './pool.server'
import { getConnection } from './store.server'

interface Running {
  pid: number
  connectionId: string
  database: string
  cancelled: boolean
}

const globalRunning = globalThis as unknown as { __dbxRunning?: Map<string, Running> }
const running = (globalRunning.__dbxRunning ??= new Map())

const TRANSACTION_WORDS = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release'])

/** Drops leading whitespace, comments and parentheses, the same way firstKeyword does. */
function withoutLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const before = s
    s = s
      .replace(/^\s+/, '')
      .replace(/^--[^\r\n]*/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '')
      .replace(/^\(/, '')
    if (s === before) return s
  }
}

function isTransactionStatement(sql: string): boolean {
  const keyword = firstKeyword(sql)
  if (keyword === null) return false
  if (TRANSACTION_WORDS.has(keyword)) return true
  // Only PREPARE TRANSACTION is refused; named prepared statements are harmless.
  if (keyword === 'prepare') return /^prepare\s+transaction\b/i.test(withoutLeadingComments(sql))
  if (keyword === 'set') {
    return /^set\s+(?:(?:local|session)\s+)?transaction\b|^set\s+session\s+characteristics\b/i.test(
      withoutLeadingComments(sql),
    )
  }
  return false
}

/**
 * Index of the first statement that changes transaction state, or -1. A read-only run wraps
 * its statements in its own transaction, so the script must not end or replace it.
 */
export function readOnlyViolation(statements: { text: string }[]): number {
  return statements.findIndex((s) => isTransactionStatement(s.text))
}

export async function executeSql(
  connectionId: string,
  database: string,
  sql: string,
  options: { maxRows: number; executionId: string },
): Promise<ExecuteResult> {
  const statements = splitStatements(sql)
  const out: ExecuteResult = {
    results: [],
    error: null,
    notices: [],
    durationMs: 0,
    rolledBack: false,
    cancelled: false,
  }
  if (statements.length === 0) return out

  // COPY over the wire needs the copy sub-protocol, which this editor does not speak
  const copyIndex = statements.findIndex((s) => /^\s*copy\b[\s\S]*\b(stdin|stdout)\b/i.test(s.text))
  if (copyIndex >= 0) {
    const s = statements[copyIndex]!
    out.error = {
      message:
        'COPY … FROM STDIN / TO STDOUT is not supported here. Use COPY with a server-side file, or the export button on results.',
      statementIndex: copyIndex,
      from: s.from,
      to: s.to,
    }
    return out
  }

  const { conn, pool } = await poolFor(connectionId, database)
  const readOnly = conn.readOnly === true
  if (readOnly) {
    const index = readOnlyViolation(statements)
    if (index >= 0) {
      const s = statements[index]!
      out.error = {
        message:
          'This connection is read-only, so transaction statements (BEGIN, COMMIT, ROLLBACK, SET TRANSACTION, ...) are not allowed.',
        statementIndex: index,
        from: s.from,
        to: s.to,
      }
      return out
    }
  }
  // If connect() fails nothing is checked out, so there is nothing to release.
  const client = await pool.connect()
  const started = performance.now()
  let txStatus = 'I'
  const onReady = (msg: { status: string }) => {
    txStatus = msg.status
  }
  const onNotice = (msg: { severity?: string; message?: string }) => {
    out.notices.push({ severity: msg.severity ?? 'NOTICE', message: msg.message ?? '' })
  }
  const connection = (client as unknown as { connection: NodeJS.EventEmitter }).connection

  let broken = false
  try {
    // Everything from here on is inside the try, so release() runs even if the setup throws.
    connection.on('readyForQuery', onReady)
    client.on('notice', onNotice)

    const entry: Running = {
      pid: (client as unknown as { processID: number }).processID,
      connectionId,
      database,
      cancelled: false,
    }
    running.set(options.executionId, entry)

    if (readOnly) {
      // The SELECT takes the snapshot, so the script cannot switch the transaction back to read-write.
      await client.query('BEGIN READ ONLY')
      await client.query('SELECT 1')
    }

    for (let index = 0; index < statements.length; index++) {
      const stmt = statements[index]!
      const t0 = performance.now()
      try {
        // Inside an open transaction the cursor joins it; otherwise the helper runs the read in its own.
        const result = await readStatement(
          client,
          stmt.text,
          options.maxRows,
          `${connectionId}::${database}`,
          txStatus !== 'I',
        )
        const res: StatementResult = {
          statement: stmt.text.length > 4000 ? `${stmt.text.slice(0, 4000)}…` : stmt.text,
          from: stmt.from,
          to: stmt.to,
          command: result.command,
          rowCount: result.rowCount,
          fields: result.fields,
          rows: result.rows as Cell[][],
          truncated: result.truncated,
          durationMs: Math.round(performance.now() - t0),
        }
        out.results.push(res)
      } catch (err) {
        const info = pgErrorInfo(err)
        if (info.code === '57014' && entry.cancelled) out.cancelled = true
        out.error = {
          ...info,
          message: out.cancelled ? 'Query cancelled' : info.message,
          position: info.position != null ? stmt.from + info.position : undefined,
          statementIndex: index,
          from: stmt.from,
          to: stmt.to,
        }
        if (!isPgError(err)) broken = true
        break
      }
    }

    // Each run is its own session: never leave an open transaction or session state behind.
    if (!broken) {
      if (readOnly) {
        // Our own wrapper transaction holds nothing to keep, so it is dropped without a warning.
        await client.query('ROLLBACK')
      } else if (txStatus === 'T' || txStatus === 'E') {
        await client.query('ROLLBACK')
        out.rolledBack = !out.error || txStatus === 'T'
        if (txStatus === 'T') {
          out.notices.push({
            severity: 'WARNING',
            message:
              'The script left a transaction open, so it was rolled back. Include COMMIT in the same run to keep the changes.',
          })
        }
      }
      await client.query('DISCARD ALL')
    }
  } catch (err) {
    broken = true
    if (!out.error) {
      out.error = { ...pgErrorInfo(err), statementIndex: -1, from: 0, to: 0 }
    }
  } finally {
    running.delete(options.executionId)
    connection.removeListener('readyForQuery', onReady)
    client.removeListener('notice', onNotice)
    client.release(broken)
    out.durationMs = Math.round(performance.now() - started)
  }
  return out
}

const PLAIN_PREFIX = 'EXPLAIN (FORMAT JSON) '
const ANALYZE_PREFIX = 'EXPLAIN (FORMAT JSON, ANALYZE true, BUFFERS true) '
/** Plans a statement with $1, $2, ... parameters. Needs PostgreSQL 16 or newer. */
const GENERIC_PREFIX = 'EXPLAIN (FORMAT JSON, GENERIC_PLAN) '
/** SQLSTATE undefined_parameter: the statement has $n but no value for it. */
const UNDEFINED_PARAMETER = '42P02'
/** In the extended protocol the same mistake shows up as a protocol error about missing bind values. */
const MISSING_BIND = /bind message supplies \d+ parameters/

/** Whether an EXPLAIN failed because the statement has $1, $2, ... parameters without values. */
export function isMissingParameters(code: string | undefined, message: string): boolean {
  return code === UNDEFINED_PARAMETER || (code === '08P01' && MISSING_BIND.test(message))
}
/** server_version_num of PostgreSQL 16.0, the first with GENERIC_PLAN. */
const GENERIC_PLAN_VERSION = 160000

/** SQLSTATE lock_not_available: a lock wait ran past lock_timeout. */
const LOCK_NOT_AVAILABLE = '55P03'

export interface UnavailableInput {
  analyze: boolean
  /** The statement has $1, $2, ... in it (see hasParameters). */
  hasParams: boolean
  /** Postgres said a parameter has no value (see isMissingParameters). */
  missingValues: boolean
  /** server_version_num, when it was read for a plain EXPLAIN; null when it was not. */
  serverVersionNum: number | null
  /** SQLSTATE of the failure, if any. */
  code: string | undefined
  /** The run was cancelled by the user. */
  cancelled: boolean
}

/**
 * Why a failed EXPLAIN gives no plan, as a reason instead of an error, or null when the failure stays an
 * error. A cancel, a lock wait and any failure of a statement without parameters stay errors. A statement
 * with parameters is shown as a reason, because nothing is broken: the plan just cannot be made for it.
 */
export function unavailableReason(input: UnavailableInput): ExplainUnavailable | null {
  if (input.cancelled || input.code === LOCK_NOT_AVAILABLE) return null
  if (!input.hasParams) return null
  if (input.missingValues) {
    if (input.analyze) return 'needs-values-analyze'
    if (input.serverVersionNum === null || input.serverVersionNum < GENERIC_PLAN_VERSION) return 'needs-newer-postgres'
  }
  return 'needs-values'
}
/** Plain EXPLAIN gives up on a lock after 3 seconds, so an ALTER TABLE or VACUUM FULL cannot hang it. */
const PLAIN_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '3s'"

/**
 * Whether a statement has $1, $2, ... parameters in place of values, as pg_stat_statements stores
 * queries. Text inside quotes ('...', "...") and dollar-quoted strings ($$...$$) is left out.
 */
export function hasParameters(sql: string): boolean {
  const code = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
  return /\$\d+/.test(code)
}

/**
 * The message for an EXPLAIN that gave up waiting for a lock, or null for any other error code
 * (the caller then keeps the message from Postgres).
 */
export function lockWaitMessage(code: string | undefined): string | null {
  if (code !== LOCK_NOT_AVAILABLE) return null
  return 'A table in this query is locked by another session (for example by ALTER TABLE). Try again in a moment.'
}

/**
 * One EXPLAIN. Normally it goes through the extended protocol, which takes exactly one statement, so
 * nothing can ride along. That protocol reads $1, $2, ... as its own bind parameters, though, so the
 * generic plan (which needs Postgres to see them as placeholders) uses the simple protocol. The text is
 * already checked to be a single statement, and it runs inside a transaction that is rolled back.
 */
async function explainOnce(client: pg.PoolClient, prefix: string, text: string): Promise<JsonValue | null> {
  // pg supports queryMode, but @types/pg does not list it yet.
  const config =
    prefix === GENERIC_PREFIX
      ? { text: prefix + text }
      : ({ text: prefix + text, queryMode: 'extended' } as pg.QueryConfig)
  const res = await client.query<{ 'QUERY PLAN': JsonValue }>(config)
  const doc = res.rows[0]?.['QUERY PLAN']
  return Array.isArray(doc) ? (doc[0] ?? null) : null
}

/** Like explainOnce, but returns the error instead of throwing it. */
async function attemptExplain(
  client: pg.PoolClient,
  prefix: string,
  text: string,
): Promise<{ ok: true; plan: JsonValue | null } | { ok: false; error: unknown }> {
  try {
    return { ok: true, plan: await explainOnce(client, prefix, text) }
  } catch (error) {
    return { ok: false, error }
  }
}

async function serverVersionNum(client: pg.PoolClient): Promise<number> {
  const res = await client.query<{ v: number }>(`SELECT current_setting('server_version_num')::int AS v`)
  return res.rows[0]!.v
}

/**
 * Runs EXPLAIN (FORMAT JSON) for one statement and returns the plan. The EXPLAIN runs inside a
 * transaction that is always rolled back, so ANALYZE measures real timings without keeping changes.
 * A statement with $1, $2, ... parameters (from pg_stat_statements) gets EXPLAIN (GENERIC_PLAN) on
 * PostgreSQL 16 or newer. That plan is an estimate, because the parameters have no values.
 *
 * A plain EXPLAIN sets lock_timeout (see PLAIN_LOCK_TIMEOUT), so it fails with 55P03 instead of waiting
 * behind an ALTER TABLE or VACUUM FULL. Explain Analyze runs the real query, so it does not set it.
 */
export async function explainSql(
  connectionId: string,
  database: string,
  sql: string,
  options: { analyze: boolean; executionId: string },
): Promise<ExplainResult> {
  const out: ExplainResult = {
    results: [],
    error: null,
    notices: [],
    durationMs: 0,
    rolledBack: false,
    cancelled: false,
    plan: null,
    analyzed: options.analyze,
    generic: false,
    unavailable: null,
  }
  const statements = splitStatements(sql)
  if (statements.length === 0) return out
  if (statements.length > 1) {
    out.error = {
      message: 'Explain works on one statement at a time. Put the cursor in a statement or select it.',
      statementIndex: -1,
      from: 0,
      to: 0,
    }
    return out
  }

  const stmt = statements[0]!
  if (firstKeyword(stmt.text) === 'explain') {
    out.error = {
      message: 'Remove EXPLAIN from the statement. The Explain button adds it.',
      statementIndex: 0,
      from: stmt.from,
      to: stmt.to,
    }
    return out
  }

  const prefix = options.analyze ? ANALYZE_PREFIX : PLAIN_PREFIX
  const { conn, pool } = await poolFor(connectionId, database)
  const readOnly = conn.readOnly === true
  // If connect() fails nothing is checked out, so there is nothing to release.
  const client = await pool.connect()
  const started = performance.now()
  const onNotice = (msg: { severity?: string; message?: string }) => {
    out.notices.push({ severity: msg.severity ?? 'NOTICE', message: msg.message ?? '' })
  }

  let broken = false
  try {
    // Everything from here on is inside the try, so release() runs even if the setup throws.
    client.on('notice', onNotice)

    const entry: Running = {
      pid: (client as unknown as { processID: number }).processID,
      connectionId,
      database,
      cancelled: false,
    }
    running.set(options.executionId, entry)

    const begin = readOnly ? 'BEGIN READ ONLY' : 'BEGIN'
    const startTransaction = async () => {
      await client.query(begin)
      if (!options.analyze) await client.query(PLAIN_LOCK_TIMEOUT)
    }
    await startTransaction()
    let usedPrefix = prefix
    let attempt = await attemptExplain(client, prefix, stmt.text)
    let version: number | null = null
    if (
      !attempt.ok &&
      !options.analyze &&
      isPgError(attempt.error) &&
      isMissingParameters(attempt.error.code, attempt.error.message)
    ) {
      // The failed EXPLAIN aborted the transaction, so it starts over before the version check.
      await client.query('ROLLBACK')
      await startTransaction()
      version = await serverVersionNum(client)
      if (version >= GENERIC_PLAN_VERSION) {
        usedPrefix = GENERIC_PREFIX
        attempt = await attemptExplain(client, GENERIC_PREFIX, stmt.text)
      }
    }

    if (attempt.ok) {
      out.plan = attempt.plan
      out.generic = usedPrefix === GENERIC_PREFIX
    } else {
      const info = pgErrorInfo(attempt.error)
      if (info.code === '57014' && entry.cancelled) out.cancelled = true
      const pgFailure = isPgError(attempt.error)
      const reason = pgFailure
        ? unavailableReason({
            analyze: options.analyze,
            hasParams: hasParameters(stmt.text),
            missingValues: isMissingParameters(info.code, info.message),
            serverVersionNum: version,
            code: info.code,
            cancelled: out.cancelled,
          })
        : null
      if (reason !== null) {
        out.unavailable = reason
        if (reason === 'needs-values') {
          // The detail stays in the Messages tab, where the note does not show it.
          out.notices.push({ severity: 'INFO', message: `Postgres could not plan the query: ${info.message}` })
        }
      } else {
        // Postgres counts positions in the prefixed text, so the prefix is taken out again.
        const position =
          info.position != null && info.position >= usedPrefix.length
            ? stmt.from + info.position - usedPrefix.length
            : undefined
        out.error = {
          ...info,
          message: out.cancelled ? 'Query cancelled' : (lockWaitMessage(info.code) ?? info.message),
          position,
          statementIndex: 0,
          from: stmt.from,
          to: stmt.to,
        }
      }
      if (!pgFailure) broken = true
    }

    // Our own wrapper transaction is always dropped, and the session state is reset after it.
    if (!broken) {
      await client.query('ROLLBACK')
      await client.query('DISCARD ALL')
    }
  } catch (err) {
    broken = true
    if (!out.error) {
      out.error = { ...pgErrorInfo(err), statementIndex: -1, from: 0, to: 0 }
    }
  } finally {
    running.delete(options.executionId)
    client.removeListener('notice', onNotice)
    client.release(broken)
    out.durationMs = Math.round(performance.now() - started)
  }
  return out
}

export async function cancelExecution(executionId: string): Promise<boolean> {
  const entry = running.get(executionId)
  if (!entry) return false
  entry.cancelled = true
  const conn = await getConnection(entry.connectionId)
  // Use a separate connection so cancelling works even when the pool is busy.
  const client = new pg.Client(await connectConfig(conn, entry.database))
  watchClient(client, 'cancel connection')
  try {
    await client.connect()
    const res = await client.query<{ ok: boolean }>('SELECT pg_cancel_backend($1) AS ok', [entry.pid])
    return res.rows[0]!.ok
  } finally {
    await client.end().catch(() => {})
  }
}

export async function testConnection(config: pg.ClientConfig): Promise<{ latencyMs: number; serverVersion: string }> {
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 8000 })
  watchClient(client, 'test connection')
  const started = performance.now()
  try {
    await client.connect()
    const res = await client.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)
    return { latencyMs: Math.round(performance.now() - started), serverVersion: res.rows[0]!.v }
  } finally {
    await client.end().catch(() => {})
  }
}
