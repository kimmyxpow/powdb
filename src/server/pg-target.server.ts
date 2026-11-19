import type { ConnectionConfig, SslMode } from '@/lib/types'
import { resolvePassword } from './store.server'
import { ensureTunnel } from './tunnel.server'

/**
 * Where a PostgreSQL client program (pg_dump, psql, pg_restore) connects for one connection.
 * The single place that turns a stored connection into host/port/user, so features such as
 * an SSH tunnel only need to change this function.
 */
interface PgTarget {
  /** where the socket goes: the real host, or 127.0.0.1 through an SSH tunnel */
  host: string
  port: number
  user: string
  database: string
  ssl: SslMode
  password?: string
  /** through a tunnel: the real host, used for the TLS certificate check (libpq host=, with hostaddr=host) */
  tlsHost?: string
}

export async function pgTarget(conn: ConnectionConfig, database: string): Promise<PgTarget> {
  const common = {
    user: conn.user,
    database,
    ssl: conn.ssl,
    password: resolvePassword(conn),
  }
  if (!conn.ssh) return { host: conn.host, port: conn.port, ...common }
  const endpoint = await ensureTunnel(conn)
  return { host: endpoint.host, port: endpoint.port, tlsHost: conn.host, ...common }
}
