import { tokenValidators } from '@/api/validators'
import { parseConnectionUrl } from '@/lib/connection-url'
import { s } from '@/lib/schema'
import { sshInputOptional } from '@/lib/ssh-input.server'
import {
  CONNECTION_COLORS,
  type ConnectionConfig,
  type ConnectionInput,
  type SshInput,
  type SshSettings,
} from '@/lib/types'
import { authenticate, effectiveAccess, type Principal } from '@/server/access.server'
import { agentDescribe, agentSchemas, agentTables } from '@/server/agent.server'
import { readAudit } from '@/server/audit.server'
import { createApiToken, listApiTokens, revokeApiToken } from '@/server/auth.server'
import { testConnection } from '@/server/execute.server'
import { closePools, connectConfig, pgErrorInfo } from '@/server/pool.server'
import { mergeSshInput } from '@/server/ssh-settings'
import { MANAGED_ERROR, createConnection, deleteConnection, toInfo, updateConnection } from '@/server/store.server'
import {
  connectionView,
  createAiFields,
  dbCall,
  editAiFields,
  findConnection,
  requireAccess,
  requireAdminUser,
  requireConnectionAdmin,
  runQuery,
  tokenConnectionIds,
  visibleConnections,
} from './core.server'
import {
  HttpError,
  errorResponse,
  errorToResponse,
  guardMutation,
  jsonResponse,
  parseBody,
  queryParam,
} from './util.server'

/** /api/v1/*: connections, queries, tokens and the audit log. */

const sslMode = s.enum(['disable', 'require', 'verify-full'])
const aiAccess = s.enum(['off', 'read', 'write'])

const connectionFields = {
  url: s.string().trim().min(1).optional(),
  name: s.string().trim().max(120).optional(),
  color: s.enum(CONNECTION_COLORS).optional(),
  host: s.string().trim().min(1).optional(),
  port: s.number().int().min(1).max(65535).optional(),
  database: s.string().trim().min(1).optional(),
  user: s.string().trim().min(1).optional(),
  password: s.string().optional(),
  ssl: sslMode.optional(),
  readOnly: s.boolean().optional(),
  production: s.boolean().optional(),
  aiAccess: aiAccess.optional(),
  /** SSH tunnel. Omitted on update = keep; null = remove. Same object as the UI sends. */
  ssh: sshInputOptional,
}
export const createConnectionBody = s.object(connectionFields)
export const patchConnectionBody = s.object({ ...connectionFields, clearPassword: s.boolean().optional() })

export const queryBody = s.object({
  connection: s.string().trim().min(1),
  sql: s.string().min(1),
  database: s.string().trim().min(1).optional(),
  maxRows: s.number().int().min(1).optional(),
  write: s.boolean().optional(),
})

export async function handleV1Request(request: Request, splat: string): Promise<Response> {
  try {
    guardMutation(request)
    const principal = await authenticate(request)
    if (!principal) {
      return errorResponse(401, 'unauthenticated', 'Sign in, or send a valid API token or the local key.')
    }
    const parts = splat.split('/').filter(Boolean).map(decodePart)
    return await route(request, principal, parts)
  } catch (err) {
    return errorToResponse(err)
  }
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new HttpError(400, 'invalid_path', 'The path contains an invalid escape.')
  }
}

function methodNotAllowed(...allowed: string[]): HttpError {
  return new HttpError(405, 'method_not_allowed', `Use ${allowed.join(' or ')} for this endpoint.`, {
    Allow: allowed.join(', '),
  })
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'No such endpoint.')
}

async function route(request: Request, p: Principal, parts: string[]): Promise<Response> {
  const [head, ...rest] = parts
  const method = request.method

  if (head === 'connections') {
    if (rest.length === 0) {
      if (method === 'GET') return listRoute(p)
      if (method === 'POST') return createRoute(request, p)
      throw methodNotAllowed('GET', 'POST')
    }
    const [id, action, ...more] = rest as [string, string?, ...string[]]
    if (action === undefined) {
      if (method === 'PATCH') return patchRoute(request, p, id)
      if (method === 'DELETE') return deleteRoute(p, id)
      throw methodNotAllowed('PATCH', 'DELETE')
    }
    if (action === 'test' && more.length === 0) {
      if (method !== 'POST') throw methodNotAllowed('POST')
      return testRoute(p, id)
    }
    if (action === 'schemas' && more.length === 0) {
      if (method !== 'GET') throw methodNotAllowed('GET')
      return schemasRoute(request, p, id)
    }
    if (action === 'tables') {
      if (method !== 'GET') throw methodNotAllowed('GET')
      if (more.length === 0) return tablesRoute(request, p, id)
      if (more.length === 2) return describeRoute(request, p, id, more[0]!, more[1]!)
    }
    throw notFound()
  }

  if (head === 'query' && rest.length === 0) {
    if (method !== 'POST') throw methodNotAllowed('POST')
    return queryRoute(request, p)
  }

  if (head === 'tokens' && rest.length <= 1) {
    if (rest.length === 0) {
      if (method === 'GET') return tokensListRoute(p)
      if (method === 'POST') return tokenCreateRoute(request, p)
      throw methodNotAllowed('GET', 'POST')
    }
    if (method !== 'DELETE') throw methodNotAllowed('DELETE')
    return tokenRevokeRoute(p, rest[0]!)
  }

  if (head === 'audit' && rest.length === 0) {
    if (method !== 'GET') throw methodNotAllowed('GET')
    return auditRoute(request, p)
  }

  throw notFound()
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function listRoute(p: Principal): Promise<Response> {
  const rows = (await visibleConnections(p))
    .map((c) => connectionView(c, effectiveAccess(p, c)))
    .filter((row) => row.access !== 'none')
  return jsonResponse(rows)
}

function parseUrl(url: string) {
  const parsed = parseConnectionUrl(url)
  if (!parsed) throw new HttpError(400, 'invalid_url', 'That is not a postgres:// connection URL.')
  return parsed
}

/** Checks an SSH object before anything is saved, so a bad one is a 400 and not a 500. */
function checkSsh(prev: SshSettings | undefined, ssh: SshInput | null | undefined): void {
  try {
    mergeSshInput(prev, ssh, (plain) => plain)
  } catch (err) {
    throw new HttpError(400, 'invalid_connection', err instanceof Error ? err.message : 'Invalid SSH settings.')
  }
}

async function createRoute(request: Request, p: Principal): Promise<Response> {
  requireConnectionAdmin(p)
  const body = await parseBody(request, createConnectionBody)
  const fromUrl = body.url ? parseUrl(body.url) : null
  const host = body.host ?? fromUrl?.host
  const database = body.database ?? fromUrl?.database
  const user = body.user ?? fromUrl?.user
  if (!host || !database || !user) {
    throw new HttpError(400, 'invalid_connection', 'Give a url, or host, database and user.')
  }
  const ai = createAiFields(p, body)
  checkSsh(undefined, body.ssh)
  const input: ConnectionInput = {
    name: body.name ?? '',
    color: body.color ?? 'blue',
    host,
    port: body.port ?? fromUrl?.port ?? 5432,
    database,
    user,
    password: (body.password ?? fromUrl?.password) || undefined,
    ssl: body.ssl ?? fromUrl?.ssl ?? 'disable',
    readOnly: ai.readOnly,
    production: body.production === true,
    aiAccess: ai.aiAccess,
    ssh: body.ssh,
  }
  const conn = await createConnection(input)
  return jsonResponse(toInfo(conn), 201)
}

/** Managed connections come from powdb.yaml and are refused before anything else is read. */
async function manageable(p: Principal, ref: string): Promise<ConnectionConfig> {
  const conn = await findConnection(p, ref)
  if (conn.managed) throw new HttpError(409, 'managed', MANAGED_ERROR)
  return conn
}

async function patchRoute(request: Request, p: Principal, id: string): Promise<Response> {
  requireConnectionAdmin(p)
  const prev = await manageable(p, id)
  const body = await parseBody(request, patchConnectionBody)
  // A url replaces the connection's location; explicit fields win over it.
  const fromUrl = body.url ? parseUrl(body.url) : null
  const ai = editAiFields(p, prev, body)
  checkSsh(prev.ssh, body.ssh)
  const database = body.database ?? fromUrl?.database ?? prev.database
  const conn = await updateConnection(prev.id, {
    name: body.name ?? prev.name,
    color: body.color ?? prev.color,
    host: body.host ?? fromUrl?.host ?? prev.host,
    port: body.port ?? fromUrl?.port ?? prev.port,
    database,
    user: body.user ?? fromUrl?.user ?? prev.user,
    password: body.password ?? (fromUrl?.password || undefined),
    clearPassword: body.clearPassword,
    ssl: body.ssl ?? fromUrl?.ssl ?? prev.ssl,
    readOnly: ai.readOnly,
    production: body.production ?? prev.production === true,
    aiAccess: ai.aiAccess,
    ssh: body.ssh,
  })
  await closePools(prev.id)
  return jsonResponse(toInfo(conn))
}

async function deleteRoute(p: Principal, id: string): Promise<Response> {
  requireConnectionAdmin(p)
  const prev = await manageable(p, id)
  await closePools(prev.id)
  await deleteConnection(prev.id)
  return jsonResponse({ ok: true })
}

/** Same check as the UI's test button: a short connect and SELECT version. Failures are a normal answer. */
async function testRoute(p: Principal, id: string): Promise<Response> {
  const conn = await findConnection(p, id)
  requireAccess(p, conn)
  try {
    const { latencyMs, serverVersion } = await testConnection(await connectConfig(conn))
    return jsonResponse({ ok: true, latencyMs, serverVersion })
  } catch (err) {
    return jsonResponse({ ok: false, error: pgErrorInfo(err).message })
  }
}

async function readableConnection(p: Principal, id: string): Promise<ConnectionConfig> {
  const conn = await findConnection(p, id)
  requireAccess(p, conn)
  return conn
}

async function schemasRoute(request: Request, p: Principal, id: string): Promise<Response> {
  const conn = await readableConnection(p, id)
  const database = queryParam(request, 'database')
  return jsonResponse(await dbCall(() => agentSchemas(conn.id, database)))
}

async function tablesRoute(request: Request, p: Principal, id: string): Promise<Response> {
  const conn = await readableConnection(p, id)
  const database = queryParam(request, 'database')
  const schema = queryParam(request, 'schema')
  return jsonResponse(await dbCall(() => agentTables(conn.id, database, schema)))
}

async function describeRoute(
  request: Request,
  p: Principal,
  id: string,
  schema: string,
  table: string,
): Promise<Response> {
  const conn = await readableConnection(p, id)
  const database = queryParam(request, 'database')
  return jsonResponse(await dbCall(() => agentDescribe(conn.id, database, schema, table)))
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function queryRoute(request: Request, p: Principal): Promise<Response> {
  const body = await parseBody(request, queryBody)
  const result = await runQuery(p, 'api', {
    connection: body.connection,
    sql: body.sql,
    database: body.database,
    maxRows: body.maxRows,
    write: body.write,
  })
  return jsonResponse(result)
}

// ---------------------------------------------------------------------------
// Tokens and audit (the signed-in admin only)
// ---------------------------------------------------------------------------

async function tokensListRoute(p: Principal): Promise<Response> {
  requireAdminUser(p)
  return jsonResponse(await listApiTokens())
}

async function tokenCreateRoute(request: Request, p: Principal): Promise<Response> {
  requireAdminUser(p)
  const body = await parseBody(request, tokenValidators().createToken)
  const { token, info } = await createApiToken({
    name: body.name,
    scope: body.scope,
    connections: await tokenConnectionIds(body.connections),
    expiresInDays: body.expiresInDays,
  })
  return jsonResponse({ token, info }, 201)
}

async function tokenRevokeRoute(p: Principal, id: string): Promise<Response> {
  requireAdminUser(p)
  if (!(await listApiTokens()).some((t) => t.id === id)) throw new HttpError(404, 'not_found', 'Token not found.')
  await revokeApiToken(id)
  return jsonResponse({ ok: true })
}

async function auditRoute(request: Request, p: Principal): Promise<Response> {
  requireAdminUser(p)
  const raw = queryParam(request, 'limit')
  let limit = 100
  if (raw !== undefined) {
    limit = Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new HttpError(400, 'invalid_request', 'limit must be a whole number from 1 to 1000.')
    }
  }
  return jsonResponse(await readAudit(limit))
}
