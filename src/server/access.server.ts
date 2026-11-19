import type { Access, ConnectionConfig, TokenScope } from '@/lib/types'
import { SESSION_COOKIE, authEnabled, getAuthFile, isLocalKey, verifyApiToken, verifySession } from './auth.server'
import { readCookie } from './http/util.server'

/**
 * Who is calling, and what they may do with each connection. Users (the signed-in admin,
 * or the local CLI) are trusted with the connection's own readOnly flag. Agents (API
 * tokens, MCP clients) are limited by scope, the connection's AI setting and readOnly.
 */
export type Principal =
  | { kind: 'user'; label: string } // signed-in admin (session) or the local CLI key on REST
  | { kind: 'agent'; label: string; scope: TokenScope; connections: 'all' | string[]; tokenId?: string }

export const LOCAL_KEY_HEADER = 'x-powview-local-key'
const AGENT_SCOPE_HEADER = 'x-powview-agent-scope'

/**
 * Credentials in priority order: Bearer token, local key header, session cookie. Once a
 * Bearer or local key is present, nothing else is tried. With auth off, a request without
 * credentials is the local user, except on /mcp, which always needs a token or the local key.
 */
export async function authenticate(request: Request, opts: { mcp?: boolean } = {}): Promise<Principal | null> {
  const authorization = request.headers.get('authorization')
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const info = await verifyApiToken(authorization.slice(7).trim())
    if (!info) return null
    return {
      kind: 'agent',
      label: info.name,
      scope: info.scope,
      connections: info.connections,
      tokenId: info.id,
    }
  }

  const localKey = request.headers.get(LOCAL_KEY_HEADER)
  if (localKey !== null) {
    if (!(await isLocalKey(localKey))) return null
    if (!opts.mcp) return { kind: 'user', label: 'local CLI' }
    // MCP clients act as agents; the CLI bridge says whether it may write.
    const scope: TokenScope = request.headers.get(AGENT_SCOPE_HEADER) === 'write' ? 'write' : 'read'
    return { kind: 'agent', label: 'local CLI', scope, connections: 'all' }
  }

  // The session cookie is for the browser UI, so /mcp does not accept it.
  // A valid session always has an admin account (verifySession checks it).
  if (!opts.mcp && (await verifySession(readCookie(request, SESSION_COOKIE)))) {
    return { kind: 'user', label: (await getAuthFile()).admin!.username }
  }

  if (!opts.mcp && !authEnabled()) return { kind: 'user', label: 'local' }
  return null
}

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }

function lowest(...levels: Access[]): Access {
  return levels.reduce((a, b) => (RANK[b] < RANK[a] ? b : a))
}

/** What this principal may do with this connection. Users ignore aiAccess. */
export function effectiveAccess(
  principal: Principal,
  conn: Pick<ConnectionConfig, 'id' | 'readOnly' | 'aiAccess'>,
): Access {
  if (principal.kind === 'user') return conn.readOnly ? 'read' : 'write'
  if (conn.aiAccess === 'off') return 'none'
  if (principal.connections !== 'all' && !principal.connections.includes(conn.id)) return 'none'
  const byScope: Access = principal.scope === 'read' ? 'read' : 'write'
  const byAi: Access = conn.aiAccess === 'read' ? 'read' : 'write'
  const byReadOnly: Access = conn.readOnly ? 'read' : 'write'
  return lowest(byScope, byAi, byReadOnly)
}

export function canManageConnections(principal: Principal): boolean {
  return principal.kind === 'user' || principal.scope === 'admin'
}

/** Tokens and the audit log are for the signed-in admin only. */
export function canManageTokens(principal: Principal): boolean {
  return principal.kind === 'user'
}
