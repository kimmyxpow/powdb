import { query } from './pool.server'
import { getConnection } from './store.server'

export interface ActivityRow {
  pid: number
  datname: string | null
  usename: string | null
  applicationName: string | null
  clientAddr: string | null
  state: string | null
  waitEventType: string | null
  waitEvent: string | null
  backendStart: string | null
  xactStart: string | null
  queryStart: string | null
  stateChange: string | null
  query: string
  /** ms since query_start for active sessions, otherwise since state_change */
  durationMs: number | null
  blockedBy: number[]
  /** PowView's own pool connections */
  isPowview: boolean
}

const toIso = (v: unknown): string | null => {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export async function listActivity(
  connectionId: string,
  database: string,
  options: { allDatabases: boolean },
): Promise<ActivityRow[]> {
  const scope = options.allDatabases ? '' : 'AND a.datname = $1'
  const values = options.allDatabases ? [] : [database]
  const rows = await query<{
    pid: number
    datname: string | null
    usename: string | null
    application_name: string | null
    client_addr: string | null
    state: string | null
    wait_event_type: string | null
    wait_event: string | null
    backend_start: Date | string | null
    xact_start: Date | string | null
    query_start: Date | string | null
    state_change: Date | string | null
    query: string | null
    duration_ms: number | null
    blocked_by: number[]
  }>(
    connectionId,
    database,
    `SELECT a.pid,
            a.datname,
            a.usename,
            a.application_name,
            a.client_addr::text AS client_addr,
            a.state,
            a.wait_event_type,
            a.wait_event,
            a.backend_start,
            a.xact_start,
            a.query_start,
            a.state_change,
            a.query,
            (CASE WHEN a.state = 'active'
                  THEN extract(epoch from now() - a.query_start)
                  ELSE extract(epoch from now() - a.state_change) END * 1000)::float8 AS duration_ms,
            pg_blocking_pids(a.pid) AS blocked_by
       FROM pg_stat_activity a
      WHERE a.backend_type = 'client backend'
        AND a.pid <> pg_backend_pid()
        ${scope}
      ORDER BY (a.state = 'active') DESC, duration_ms DESC NULLS LAST
      LIMIT 500`,
    values,
  )
  return rows.map((r) => ({
    pid: Number(r.pid),
    datname: r.datname,
    usename: r.usename,
    applicationName: r.application_name,
    clientAddr: r.client_addr,
    state: r.state,
    waitEventType: r.wait_event_type,
    waitEvent: r.wait_event,
    backendStart: toIso(r.backend_start),
    xactStart: toIso(r.xact_start),
    queryStart: toIso(r.query_start),
    stateChange: toIso(r.state_change),
    query: r.query ?? '',
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    blockedBy: r.blocked_by.map(Number),
    isPowview: r.application_name === 'powview',
  }))
}

export async function signalBackend(
  connectionId: string,
  database: string,
  pid: number,
  action: 'cancel' | 'terminate',
): Promise<void> {
  const conn = await getConnection(connectionId)
  if (conn.readOnly) throw new Error('This connection is read-only.')
  const fn = action === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'
  const [row] = await query<{ ok: boolean }>(connectionId, database, `SELECT ${fn}($1) AS ok`, [pid])
  if (!row?.ok) {
    throw new Error('The query had already finished, or you are not allowed to stop it.')
  }
}
