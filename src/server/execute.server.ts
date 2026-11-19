import pg from 'pg'
import { splitStatements } from '@/lib/sql'
import type { Cell, ExecuteResult, StatementResult } from '@/lib/types'
import { firstKeyword } from './cursor.server'
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
