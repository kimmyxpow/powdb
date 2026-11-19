import type { Access, AiAccess, ConnectionConfig } from '@/lib/types'
import { canManageConnections, canManageTokens, effectiveAccess, type Principal } from '@/server/access.server'
import { runAgentQuery, isReadOnlySql, type AgentQueryResult } from '@/server/agent.server'
import { appendAudit } from '@/server/audit.server'
import { listConnections, toInfo } from '@/server/store.server'
import { HttpError } from './util.server'

/**
 * Rules shared by the REST API and MCP: which connections a principal can see, what it may
 * do with them, and the one audited path that runs a query.
 */

const AI_RANK: Record<AiAccess, number> = { off: 0, read: 1, write: 2 }

const AGENT_NO_AI_WRITE = 'Agents cannot give a connection AI write access. Only the admin can do that in PowDBs.'
const AGENT_NO_LOOSEN_AI = 'Agents can make AI access stricter, not looser. Only the admin can raise it.'
const AGENT_NO_UNLOCK = 'Agents cannot make a read-only connection writable. Only the admin can do that.'

/** A token limited to some connections cannot see the others, so they do not exist for it. */
function visibleTo(principal: Principal, conn: Pick<ConnectionConfig, 'id'>): boolean {
  if (principal.kind === 'user') return true
  return principal.connections === 'all' || principal.connections.includes(conn.id)
}

export async function visibleConnections(principal: Principal): Promise<ConnectionConfig[]> {
  return (await listConnections()).filter((c) => visibleTo(principal, c))
}

/** Matches an id first, then an exact name. An ambiguous name asks for the id. */
function matchConnection(candidates: ConnectionConfig[], ref: string): ConnectionConfig {
  const byId = candidates.find((c) => c.id === ref)
  if (byId) return byId
  const byName = candidates.filter((c) => c.name === ref)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    throw new HttpError(409, 'ambiguous_connection', `More than one connection is named "${ref}". Use its id instead.`)
  }
  throw new HttpError(404, 'not_found', `No connection matches "${ref}".`)
}

export async function findConnection(principal: Principal, ref: string): Promise<ConnectionConfig> {
  return matchConnection(await visibleConnections(principal), ref)
}

/** The connections a new token may use, from ids or exact names. 'all' and an omitted list pass through. */
export async function tokenConnectionIds(refs: 'all' | string[] | undefined): Promise<'all' | string[] | undefined> {
  if (!refs || refs === 'all') return refs
  const all = await listConnections()
  return refs.map((ref) => matchConnection(all, ref).id)
}

/** The access level for this principal, or a 403 when it has none. */
export function requireAccess(principal: Principal, conn: ConnectionConfig): Access {
  const level = effectiveAccess(principal, conn)
  if (level === 'none') {
    throw new HttpError(
      403,
      'no_access',
      conn.aiAccess === 'off'
        ? `AI access is off for "${conn.name}". An admin can turn it on in the connection settings.`
        : `This token cannot use "${conn.name}".`,
    )
  }
  return level
}

export function requireConnectionAdmin(principal: Principal): void {
  if (!canManageConnections(principal)) {
    throw new HttpError(403, 'forbidden', 'This token cannot change connections. It needs the admin scope.')
  }
}

export function requireAdminUser(principal: Principal): void {
  if (!canManageTokens(principal)) {
    throw new HttpError(403, 'forbidden', 'Only the signed-in admin can manage tokens and read the audit log.')
  }
}

interface AiFields {
  aiAccess?: AiAccess
  readOnly?: boolean
}

/**
 * Values for a new connection. Users choose freely. Agents can only create connections that
 * are off or read-only for AI, and never writable.
 */
export function createAiFields(principal: Principal, requested: AiFields): { aiAccess: AiAccess; readOnly: boolean } {
  if (principal.kind === 'user') {
    return { aiAccess: requested.aiAccess ?? 'read', readOnly: requested.readOnly ?? false }
  }
  if (requested.aiAccess === 'write') throw new HttpError(403, 'agent_loosening', AGENT_NO_AI_WRITE)
  return { aiAccess: requested.aiAccess === 'off' ? 'off' : 'read', readOnly: requested.readOnly === true }
}

/**
 * Values after an edit. Users choose freely. Agents may tighten AI access or make a
 * connection read-only; any loosening is refused with a 403.
 */
export function editAiFields(
  principal: Principal,
  prev: Pick<ConnectionConfig, 'aiAccess' | 'readOnly'>,
  requested: AiFields,
): { aiAccess: AiAccess; readOnly: boolean } {
  if (principal.kind === 'user') {
    return { aiAccess: requested.aiAccess ?? prev.aiAccess, readOnly: requested.readOnly ?? prev.readOnly }
  }
  if (requested.aiAccess !== undefined && AI_RANK[requested.aiAccess] > AI_RANK[prev.aiAccess]) {
    throw new HttpError(403, 'agent_loosening', AGENT_NO_LOOSEN_AI)
  }
  if (requested.readOnly === false && prev.readOnly) throw new HttpError(403, 'agent_loosening', AGENT_NO_UNLOCK)
  return { aiAccess: requested.aiAccess ?? prev.aiAccess, readOnly: requested.readOnly ?? prev.readOnly }
}

/** Connection view for REST clients: the store's info (no password) plus this principal's access. */
export function connectionView(conn: ConnectionConfig, access: Access) {
  return { ...toInfo(conn), access }
}

export function compactConnection(conn: ConnectionConfig, access: Access) {
  return {
    id: conn.id,
    name: conn.name,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    readOnly: conn.readOnly,
    aiAccess: conn.aiAccess,
    managed: conn.managed === true,
    access,
  }
}

/** Errors from database introspection become 400s with the database's own message. */
export async function dbCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(400, 'database_error', err instanceof Error ? err.message : String(err))
  }
}

interface QueryRequest {
  connection: string
  sql: string
  database?: string
  maxRows?: number
  /** run with write access; needs effective write access on the connection */
  write?: boolean
  /** run EXPLAIN (ANALYZE when asked) on a read-only statement */
  explain?: { analyze: boolean }
}

function writeDeniedMessage(principal: Principal, conn: ConnectionConfig): string {
  if (principal.kind === 'agent' && principal.scope === 'read') {
    return 'This token has read scope. Use a token with write scope to run writes.'
  }
  if (principal.kind === 'agent' && conn.aiAccess !== 'write') {
    return `AI write access is not enabled for "${conn.name}". An admin can allow it in the connection settings.`
  }
  return `"${conn.name}" is read-only. Writes need the connection to be writable.`
}

/**
 * The one path that runs a query for REST and MCP. Every call is audited, including the
 * refused ones. Errors come back as HttpError.
 */
export async function runQuery(
  principal: Principal,
  source: 'api' | 'mcp',
  input: QueryRequest,
): Promise<AgentQueryResult> {
  const started = performance.now()
  let conn: ConnectionConfig | null = null
  let access: 'read' | 'write' = input.write ? 'write' : 'read'
  let database = input.database ?? ''
  let sql = input.sql
  let result: AgentQueryResult
  try {
    conn = await findConnection(principal, input.connection)
    database = input.database || conn.database
    const level = requireAccess(principal, conn)
    if (input.write && level !== 'write') throw new HttpError(403, 'write_denied', writeDeniedMessage(principal, conn))
    if (input.explain) {
      const verdict = isReadOnlySql(input.sql)
      if (!verdict.ok) throw new HttpError(400, 'read_only', verdict.reason)
      sql = `EXPLAIN ${input.explain.analyze ? '(ANALYZE, BUFFERS) ' : ''}${input.sql}`
      access = 'read'
    }
    result = await runAgentQuery({
      connectionId: conn.id,
      database: input.database || undefined,
      sql,
      access,
      maxRows: input.maxRows,
    })
  } catch (err) {
    const failure = err instanceof HttpError ? err : new HttpError(400, 'query_failed', errorMessage(err))
    await record(principal, source, {
      conn,
      connection: input.connection,
      database,
      sql,
      access,
      ok: false,
      error: failure.message,
      durationMs: Math.round(performance.now() - started),
    })
    throw failure
  }
  await record(principal, source, {
    conn,
    connection: input.connection,
    database,
    sql,
    access,
    ok: true,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
  })
  return result
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function record(
  principal: Principal,
  source: 'api' | 'mcp',
  entry: {
    conn: ConnectionConfig | null
    connection: string
    database: string
    sql: string
    access: 'read' | 'write'
    ok: boolean
    error?: string
    rowCount?: number | null
    durationMs: number
  },
): Promise<void> {
  await appendAudit({
    at: new Date().toISOString(),
    source,
    actor: principal.label,
    tokenId: principal.kind === 'agent' ? principal.tokenId : undefined,
    connectionId: entry.conn?.id ?? entry.connection,
    connectionName: entry.conn?.name ?? entry.connection,
    database: entry.database,
    access: entry.access,
    sql: entry.sql,
    ok: entry.ok,
    error: entry.error,
    rowCount: entry.rowCount,
    durationMs: entry.durationMs,
  })
}
