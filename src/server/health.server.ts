import { query } from './pool.server'

// Health checks read only PostgreSQL's statistics views. None of them scans user tables.

/** The text pg_stat_statements shows for a statement the current role may not see. */
const HIDDEN_QUERY = '<insufficient privilege>'

export interface DatabaseHealth {
  /** When the statistics of the current database were last reset, as an ISO string */
  statsSince: string | null
  statements: StatementsHealth
  unusedIndexes: { schema: string; table: string; index: string; bytes: number }[]
  vacuum: { schema: string; table: string; deadRows: number; liveRows: number; lastVacuum: string | null }[]
  fullReads: {
    schema: string
    table: string
    seqScans: number
    indexScans: number
    rowsRead: number
    liveRows: number
  }[]
}

export interface StatementsHealth {
  status: 'ok' | 'not-installed' | 'not-loaded' | 'error'
  /** the Postgres message, when status is 'error' */
  message: string | null
  rows: {
    /** null when the role may not see the text */
    query: string | null
    calls: number
    totalMs: number
    meanMs: number
    rows: number
    /** this statement's share of the total time of all statements in the database (0 to 1) */
    share: number
  }[]
}

export type StatementRow = StatementsHealth['rows'][number]

interface RawStatement {
  query: string | null
  calls: string | number
  total_ms: number | null
  mean_ms: number | null
  rows: string | number
  share: number | null
}

interface RawUnusedIndex {
  schema: string
  table: string
  index: string
  bytes: string | number | null
}

interface RawVacuum {
  schema: string
  table: string
  dead_rows: string | number
  live_rows: string | number
  last_vacuum: Date | string | null
}

interface RawFullRead {
  schema: string
  table: string
  seq_scan: string | number
  idx_scan: string | number
  rows_read: string | number
  live_rows: string | number
}

const num = (v: unknown): number => (v == null ? 0 : Number(v))

const toIso = (v: unknown): string | null => {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** Statement rows as the client shows them. Counts come back from PostgreSQL as strings, so they are converted here. */
export function mapStatementRows(rows: RawStatement[]): StatementRow[] {
  return rows.map((r) => ({
    query: r.query == null || r.query === HIDDEN_QUERY ? null : r.query,
    calls: num(r.calls),
    totalMs: num(r.total_ms),
    meanMs: num(r.mean_ms),
    rows: num(r.rows),
    share: num(r.share),
  }))
}

/**
 * Turns an error from reading pg_stat_statements into a status. Without shared_preload_libraries
 * PostgreSQL refuses to read the view, and its message names that setting.
 */
export function statementsFailure(message: string): StatementsHealth {
  if (message.includes('shared_preload_libraries')) return { status: 'not-loaded', message: null, rows: [] }
  return { status: 'error', message, rows: [] }
}

export function mapUnusedIndexes(rows: RawUnusedIndex[]): DatabaseHealth['unusedIndexes'] {
  return rows.map((r) => ({ schema: r.schema, table: r.table, index: r.index, bytes: num(r.bytes) }))
}

export function mapVacuum(rows: RawVacuum[]): DatabaseHealth['vacuum'] {
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    deadRows: num(r.dead_rows),
    liveRows: num(r.live_rows),
    lastVacuum: toIso(r.last_vacuum),
  }))
}

export function mapFullReads(rows: RawFullRead[]): DatabaseHealth['fullReads'] {
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    seqScans: num(r.seq_scan),
    indexScans: num(r.idx_scan),
    rowsRead: num(r.rows_read),
    liveRows: num(r.live_rows),
  }))
}

const STATEMENTS_SQL = `SELECT query, calls, total_exec_time AS total_ms, mean_exec_time AS mean_ms, rows,
       total_exec_time / nullif(sum(total_exec_time) OVER (), 0) AS share
  FROM pg_stat_statements
 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
   -- EXPLAIN only plans a query, it never runs it, so it is not a slow query (pow/view runs it too)
   AND query !~* '^\\s*explain\\M'
 ORDER BY total_exec_time DESC
 LIMIT 20`

async function readStatsSince(connectionId: string, database: string): Promise<string | null> {
  const rows = await query<{ stats_reset: Date | string | null }>(
    connectionId,
    database,
    `SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`,
  ).catch(() => [])
  return toIso(rows[0]?.stats_reset)
}

async function readStatements(connectionId: string, database: string): Promise<StatementsHealth> {
  const read = async (): Promise<StatementsHealth> => {
    const installed = await query(
      connectionId,
      database,
      `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`,
    )
    if (installed.length === 0) return { status: 'not-installed', message: null, rows: [] }
    const rows = await query<RawStatement>(connectionId, database, STATEMENTS_SQL)
    return { status: 'ok', message: null, rows: mapStatementRows(rows) }
  }
  // this part never throws: the other sections still show when the extension is off or unreadable
  return read().catch((err: unknown) => statementsFailure(err instanceof Error ? err.message : String(err)))
}

export async function getDatabaseHealth(connectionId: string, database: string): Promise<DatabaseHealth> {
  const [statsSince, statements, unusedIndexes, vacuum, fullReads] = await Promise.all([
    readStatsSince(connectionId, database),
    readStatements(connectionId, database),
    query<RawUnusedIndex>(
      connectionId,
      database,
      `SELECT s.schemaname AS schema, s.relname AS table, s.indexrelname AS index, pg_relation_size(s.indexrelid) AS bytes
         FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
        WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
          -- an index of a partition belongs to its parent's index and cannot be dropped on its own
          AND NOT EXISTS (SELECT 1 FROM pg_inherits inh WHERE inh.inhrelid = s.indexrelid)
        ORDER BY 4 DESC LIMIT 20`,
    ).then(mapUnusedIndexes),
    query<RawVacuum>(
      connectionId,
      database,
      `SELECT schemaname AS schema, relname AS table, n_dead_tup AS dead_rows, n_live_tup AS live_rows,
              greatest(last_vacuum, last_autovacuum) AS last_vacuum
         FROM pg_stat_user_tables
        WHERE n_dead_tup >= 1000 AND n_dead_tup > 0.1 * greatest(n_live_tup, 1)
        ORDER BY n_dead_tup DESC LIMIT 20`,
    ).then(mapVacuum),
    query<RawFullRead>(
      connectionId,
      database,
      `SELECT schemaname AS schema, relname AS table, seq_scan, coalesce(idx_scan, 0) AS idx_scan,
              seq_tup_read AS rows_read, n_live_tup AS live_rows
         FROM pg_stat_user_tables
        WHERE n_live_tup >= 10000 AND seq_scan > coalesce(idx_scan, 0) AND seq_scan >= 50
        ORDER BY seq_tup_read DESC LIMIT 20`,
    ).then(mapFullReads),
  ])
  return { statsSince, statements, unusedIndexes, vacuum, fullReads }
}
