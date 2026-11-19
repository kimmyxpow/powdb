import type { SslMode } from './types'

interface ParsedUrl {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: SslMode
}

export function looksLikeUrl(value: string): boolean {
  return /^postgres(ql)?:\/\//i.test(value.trim())
}

/** decodeURIComponent, but a value with a bare % (not an escape) is kept as typed. */
function decodeOrKeep(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parse postgres://user:pass@host:port/db?sslmode=require
 * A password is pasted as typed, so it can hold # / ? : and @. The credentials are cut off by hand:
 * the LAST @ ends them (a host never holds one), and the first : in them ends the user name.
 * Only the address part (host, port, database, params) goes through the URL parser.
 */
export function parseConnectionUrl(value: string): ParsedUrl | null {
  const trimmed = value.trim()
  if (!looksLikeUrl(trimmed)) return null
  try {
    const rest = trimmed.replace(/^postgres(ql)?:\/\//i, '')
    const at = rest.lastIndexOf('@')
    const credentials = at === -1 ? '' : rest.slice(0, at)
    const address = at === -1 ? rest : rest.slice(at + 1)
    const colon = credentials.indexOf(':')
    const rawUser = colon === -1 ? credentials : credentials.slice(0, colon)
    const rawPassword = colon === -1 ? '' : credentials.slice(colon + 1)

    const u = new URL(`http://${address}`)
    const sslmode = (u.searchParams.get('sslmode') ?? '').toLowerCase()
    const sslParam = (u.searchParams.get('ssl') ?? '').toLowerCase()
    let ssl: SslMode = 'disable'
    if (sslmode === 'verify-full' || sslmode === 'verify-ca') ssl = 'verify-full'
    else if (sslmode && sslmode !== 'disable') ssl = 'require'
    else if (sslParam === 'true' || sslParam === '1') ssl = 'require'
    const host = decodeURIComponent(u.hostname).replace(/^\[|\]$/g, '')
    return {
      host: host || 'localhost',
      port: u.port ? Number(u.port) : 5432,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      user: decodeOrKeep(rawUser) || 'postgres',
      password: decodeOrKeep(rawPassword),
      ssl,
    }
  } catch {
    return null
  }
}

export function buildConnectionUrl(c: {
  host: string
  port: number
  database: string
  user: string
  ssl: SslMode
}): string {
  const host = c.host.includes(':') ? `[${c.host}]` : c.host
  const ssl = c.ssl === 'disable' ? '' : `?sslmode=${c.ssl}`
  return `postgresql://${encodeURIComponent(c.user)}@${host}:${c.port}/${encodeURIComponent(c.database)}${ssl}`
}
