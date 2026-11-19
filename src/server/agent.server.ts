import { splitStatements, type StatementRange } from '@/lib/sql'
import type { ResultField } from '@/lib/types'
import { firstKeyword } from './cursor.server'
import { readStatement, type StatementOutput } from './data.server'
import { getRelationDetails, listAllRelations, listSchemas } from './introspect.server'
import { isPgError, poolFor, toError } from './pool.server'
import { getConnection } from './store.server'

/**
 * Queries run for AI agents (MCP, REST tokens) and for REST users. The SQL is checked
 * first, then run in a transaction that the database itself enforces: READ ONLY for reads,
 * one normal transaction for writes. The keyword check is a fast, friendly first line.
 */

export interface AgentQueryResult {
  columns: { name: string; type: string }[]
  rows: Record<string, string | null>[]
  rowCount: number | null
  truncated: boolean
  durationMs: number
  command: string | null
}

interface AgentQueryInput {
  connectionId: string
  /** defaults to the connection's own database */
  database?: string
  sql: string
  access: 'read' | 'write'
  /** default 200, capped at 1000 */
  maxRows?: number
  /** statement timeout, default 15000 */
  timeoutMs?: number
}

const MAX_ROWS = 1000
const DEFAULT_ROWS = 200
const DEFAULT_TIMEOUT_MS = 15_000

const READ_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'values', 'table'])
const TRANSACTION_KEYWORDS = new Set(['begin', 'commit', 'rollback', 'abort', 'start', 'end', 'savepoint', 'release'])
const READ_ONLY_REASON =
  'Only one read-only statement (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) is allowed with read access.'

/** Anything whose first word cannot be read is rejected (fails closed). */
export function isReadOnlySql(sql: string): { ok: true } | { ok: false; reason: string } {
  const statements = splitStatements(sql)
  const keyword = statements.length === 1 ? firstKeyword(statements[0]!.text) : null
  if (keyword && READ_KEYWORDS.has(keyword)) return { ok: true }
  return { ok: false, reason: READ_ONLY_REASON }
}

function checkWriteStatements(statements: StatementRange[]): void {
  if (statements.length === 0) throw new Error('No statement to run.')
  for (const s of statements) {
    const keyword = firstKeyword(s.text)
    // PowDBs owns the transaction, so statements that would end or nest it are refused.
    if (keyword && TRANSACTION_KEYWORDS.has(keyword)) {
      throw new Error(
        'Transaction statements (BEGIN, COMMIT, ROLLBACK, SAVEPOINT, ...) are not allowed. PowDBs wraps the request in one transaction.',
      )
    }
    // COPY needs the copy sub-protocol, which this query path does not speak.
    if (keyword === 'copy' && /\b(stdin|stdout)\b/i.test(s.text)) {
      throw new Error('COPY ... FROM STDIN / TO STDOUT is not supported here.')
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Values as text for agents. Booleans become "true"/"false"; null stays null. */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function toRecord(fields: ResultField[], row: unknown[]): Record<string, string | null> {
  // Null prototype, so a column named "__proto__" stays an ordinary key.
  const out: Record<string, string | null> = Object.create(null)
  fields.forEach((f, i) => {
    out[f.name] = toText(row[i])
  })
  return out
}

export async function runAgentQuery(input: AgentQueryInput): Promise<AgentQueryResult> {
  const readOnly = input.access === 'read'
  const maxRows = clamp(input.maxRows ?? DEFAULT_ROWS, 1, MAX_ROWS)
  const timeoutMs = clamp(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 10 * 60_000)
  const statements = splitStatements(input.sql)

  if (readOnly) {
    const verdict = isReadOnlySql(input.sql)
    if (!verdict.ok) throw new Error(verdict.reason)
  } else {
    checkWriteStatements(statements)
  }

  const { conn, pool } = await poolFor(input.connectionId, input.database)
  const cacheKey = `${conn.id}::${input.database || conn.database}`
  const started = performance.now()
  const client = await pool.connect()
  let broken = false
  let failure: unknown = null
  const outcomes: StatementOutput[] = []
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`)
    for (const s of statements) outcomes.push(await readStatement(client, s.text, maxRows, cacheKey, true))
    if (!readOnly) await client.query('COMMIT')
  } catch (err) {
    failure = err
  } finally {
    // Reads always end with ROLLBACK, even on success. Failed writes roll back too.
    if (readOnly || failure) await client.query('ROLLBACK').catch(() => (broken = true))
    // A network error leaves the connection unusable, so the client is discarded.
    if (failure && !isPgError(failure)) broken = true
    // Session settings (search_path, SET, temp tables) must not leak to the next caller.
    if (!broken) await client.query('DISCARD ALL').catch(() => (broken = true))
    client.release(broken)
  }
  if (failure) throw toError(failure)

  const last = outcomes[outcomes.length - 1]!
  // Statements without a count (DDL) do not add to the total. Truncated output has no total.
  const counted = outcomes.filter((o) => o.rowCount !== null)
  const truncated = outcomes.some((o) => o.truncated)
  return {
    columns: last.fields.map((f) => ({ name: f.name, type: f.typeName })),
    rows: last.rows.map((row) => toRecord(last.fields, row)),
    rowCount: truncated || counted.length === 0 ? null : counted.reduce((sum, o) => sum + o.rowCount!, 0),
    truncated: last.truncated,
    durationMs: Math.round(performance.now() - started),
    command: last.command,
  }
}

async function databaseFor(connectionId: string, database?: string): Promise<string> {
  return database || (await getConnection(connectionId)).database
}

export async function agentSchemas(
  connectionId: string,
  database?: string,
): Promise<{ name: string; isSystem: boolean }[]> {
  const db = await databaseFor(connectionId, database)
  return (await listSchemas(connectionId, db)).map((s) => ({ name: s.name, isSystem: s.isSystem }))
}

/** All user schemas when `schema` is omitted. */
export async function agentTables(
  connectionId: string,
  database?: string,
  schema?: string,
): Promise<{ schema: string; name: string; kind: string; estimatedRows: number | null; comment: string | null }[]> {
  const db = await databaseFor(connectionId, database)
  const relations = await listAllRelations(connectionId, db)
  return relations
    .filter((r) => !schema || r.schema === schema)
    .map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      estimatedRows: r.estimatedRows,
      comment: r.comment,
    }))
}

interface AgentTableDescription {
  schema: string
  name: string
  kind: string
  comment: string | null
  columns: {
    name: string
    type: string
    nullable: boolean
    default: string | null
    primaryKey: boolean
    references: { schema: string; table: string; column: string } | null
  }[]
  indexes: { name: string; definition: string }[]
}

export async function agentDescribe(
  connectionId: string,
  database: string | undefined,
  schema: string,
  table: string,
): Promise<AgentTableDescription> {
  const db = await databaseFor(connectionId, database)
  const d = await getRelationDetails(connectionId, db, schema, table)
  return {
    schema: d.schema,
    name: d.name,
    kind: d.kind,
    comment: d.comment,
    columns: d.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: c.defaultValue,
      primaryKey: c.isPrimaryKey,
      references: c.foreignKey,
    })),
    indexes: d.indexes.map((i) => ({ name: i.name, definition: i.definition })),
  }
}
