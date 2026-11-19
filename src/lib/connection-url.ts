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

/** Parse postgres://user:pass@host:port/db?sslmode=require */
export function parseConnectionUrl(value: string): ParsedUrl | null {
  const trimmed = value.trim()
  if (!looksLikeUrl(trimmed)) return null
  try {
    const u = new URL(trimmed.replace(/^postgres(ql)?:/i, 'http:'))
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
      user: decodeURIComponent(u.username) || 'postgres',
      password: decodeURIComponent(u.password),
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
