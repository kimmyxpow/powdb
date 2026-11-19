// Pure draft builder: no sockets, no files, no store. The store is only read by the caller.
import type { ConnectionConfig, ConnectionInput } from '@/lib/types'
import { mergeSshInput } from './ssh-settings'

/**
 * The connection to test before saving. Its secrets take the same form as a saved connection
 * (sealed, never plain text), so every later step (resolvePassword, the SSH tunnel) reads them
 * unchanged. A draft is only tested, never saved, so the sealed values exist in memory only.
 * - a typed password is sealed with `seal`; it replaces any saved password or passwordEnv
 * - without a typed password, a saved connection keeps its stored password and passwordEnv as they are
 * - clearPassword leaves the draft with no password
 * `seal` encrypts a new secret (encryptSecret in the server, a fake in tests).
 */
export function draftConnection(
  saved: ConnectionConfig | null,
  input: ConnectionInput,
  seal: (plain: string) => string,
): ConnectionConfig {
  let password: string | undefined
  let passwordEnv: string | undefined
  if (input.password) {
    password = seal(input.password)
  } else if (saved && !input.clearPassword) {
    password = saved.password
    passwordEnv = saved.passwordEnv
  }
  const conn: ConnectionConfig = {
    id: saved?.id ?? 'test',
    name: input.name,
    color: input.color,
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    password,
    ssl: input.ssl,
    readOnly: input.readOnly,
    production: input.production === true,
    aiAccess: input.aiAccess ?? 'read',
    createdAt: '',
  }
  if (passwordEnv) conn.passwordEnv = passwordEnv
  const ssh = mergeSshInput(saved?.ssh, input.ssh, seal)
  if (ssh) conn.ssh = ssh
  return conn
}
