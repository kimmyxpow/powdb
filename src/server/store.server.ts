import path from 'node:path'
import { parseConnectionUrl } from '@/lib/connection-url'
import { s } from '@/lib/schema'
import { CONNECTION_COLORS } from '@/lib/types'
import type { ConnectionConfig, ConnectionInfo, ConnectionInput } from '@/lib/types'
import { loadManagedConnections, type ManagedConnection } from './config.server'
import { parseDataFile, writeJsonFile } from './json-file.server'
import { decryptSecret, encryptSecret, isEncrypted } from './secret.server'
import { mergeSshInput, sshInfo } from './ssh-settings'

/** Shown instead of saving when someone tries to edit or delete a powdb.yaml connection. */
export const MANAGED_ERROR = 'Managed by powdb.yaml. Change the file and restart PowDB.'

/**
 * Everything PowDB keeps on disk lives here: $POWDB_DATA_DIR, else ./.data.
 * Read on every call so tests can point it elsewhere.
 */
export function dataDir(): string {
  const setting = process.env.POWDB_DATA_DIR
  return setting ? path.resolve(setting) : path.resolve(process.cwd(), '.data')
}

/**
 * Location: $POWDB_DATA_DIR/connections.json (default: ./.data).
 * Passwords in this file are encrypted (see secret.server.ts); the cache holds them encrypted too.
 */
function connectionsFile(): string {
  return path.join(dataDir(), 'connections.json')
}

interface StoreFile {
  version: 1
  connections: ConnectionConfig[]
}

/**
 * Checks connections.json on load against the current shape. Fields the type marks optional
 * (password, passwordEnv, ssh, managed, lastUsedAt) may be missing; the rest are required.
 * Unknown keys are dropped.
 */
const sshSchema = s.object({
  host: s.string(),
  port: s.number(),
  user: s.string(),
  auth: s.enum(['password', 'key']),
  password: s.string().optional(),
  privateKey: s.string().optional(),
  passphrase: s.string().optional(),
  hostKey: s.string().optional(),
  passwordEnv: s.string().optional(),
  privateKeyEnv: s.string().optional(),
  privateKeyFile: s.string().optional(),
  passphraseEnv: s.string().optional(),
})

const connectionSchema = s.object({
  id: s.string(),
  name: s.string(),
  color: s.enum(CONNECTION_COLORS),
  host: s.string(),
  port: s.number(),
  database: s.string(),
  user: s.string(),
  password: s.string().optional(),
  passwordEnv: s.string().optional(),
  ssl: s.enum(['disable', 'require', 'verify-full']),
  readOnly: s.boolean(),
  production: s.boolean(),
  aiAccess: s.enum(['off', 'read', 'write']),
  ssh: sshSchema.optional(),
  managed: s.boolean().optional(),
  createdAt: s.string(),
  lastUsedAt: s.string().optional(),
})

const storeFileSchema = s.object({
  connections: s.array(connectionSchema).default([]),
})

/** Parses and checks connections.json text. Throws a message that names the file, and never overwrites it. */
export function parseStoreFile(raw: string, file: string): ConnectionConfig[] {
  return parseDataFile(raw, file, storeFileSchema).connections
}

let cache: StoreFile | null = null
let loading: Promise<StoreFile> | null = null

async function load(): Promise<StoreFile> {
  if (cache) return cache
  // Concurrent first calls share one read, so the powdb.yaml reconcile runs once.
  loading ??= readStore()
    .then(async (data) => {
      const managed = await loadManagedConnections(dataDir())
      // null = powdb.yaml is invalid: keep whatever is stored instead of dropping it.
      if (managed && reconcileManaged(data, managed)) await persist(data)
      cache = data
      return data
    })
    .finally(() => {
      loading = null
    })
  return loading
}

async function readStore(): Promise<StoreFile> {
  let raw: string
  try {
    raw = await Bun.file(connectionsFile()).text()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // first start: optionally pre-create connections (handy for Docker)
    const data: StoreFile = { version: 1, connections: seedConnections() }
    if (data.connections.length) await persist(data)
    return data
  }
  return { version: 1, connections: parseStoreFile(raw, connectionsFile()) }
}

/** Encrypts a password that is about to be stored at startup. If that fails, keeps it as it is. */
function sealAtLoad(plain: string | undefined): string | undefined {
  if (!plain) return undefined
  if (isEncrypted(plain)) return plain
  try {
    return encryptSecret(plain)
  } catch (err) {
    // never keep a password in clear text: fail at startup with the reason (e.g. a short POWDB_SECRET)
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`A connection password could not be encrypted: ${reason}`)
  }
}

/** True when the stored value already holds this plain password (no need to encrypt it again). */
function sameSecret(stored: string | undefined, plain: string | undefined): boolean {
  if (!stored || !plain) return false
  if (stored === plain) return true
  try {
    return decryptSecret(stored) === plain
  } catch {
    return false
  }
}

/**
 * Make the managed entries in connections.json match powdb.yaml: add or update the ones in
 * the file, drop the managed ones that are gone. Returns true when anything changed.
 * Ids are the key, so a UI connection with the same id becomes managed.
 */
function reconcileManaged(data: StoreFile, managed: ManagedConnection[]): boolean {
  const before = JSON.stringify(data.connections)
  const wanted = new Set(managed.map((m) => m.id))
  data.connections = data.connections.filter((c) => !c.managed || wanted.has(c.id))
  const now = new Date().toISOString()
  for (const def of managed) {
    const index = data.connections.findIndex((c) => c.id === def.id)
    if (index === -1) {
      data.connections.push({ ...def, password: sealAtLoad(def.password), createdAt: now })
    } else {
      const prev = data.connections[index]!
      data.connections[index] = {
        ...prev,
        ...def,
        // Keep the stored ciphertext when the password is unchanged, so the file is not rewritten each start.
        password: sameSecret(prev.password, def.password) ? prev.password : sealAtLoad(def.password),
        createdAt: prev.createdAt,
        lastUsedAt: prev.lastUsedAt,
      }
    }
  }
  return JSON.stringify(data.connections) !== before
}

/**
 * POWDB_CONNECTIONS: one connection per line (or separated by ";"), either a plain URL or
 * "Name=postgresql://user:pass@host:5432/db". Only used when no connections file exists yet.
 */
function seedConnections(): ConnectionConfig[] {
  const raw = process.env.POWDB_CONNECTIONS?.trim()
  if (!raw) return []
  const colors = CONNECTION_COLORS.filter((c) => c !== 'neutral')
  const out: ConnectionConfig[] = []
  const entries = raw
    .split(/[\n;]+/)
    .map((e) => e.trim())
    .filter(Boolean)
  for (const [index, entry] of entries.entries()) {
    const m = /^([^=]+?)\s*=\s*(postgres(?:ql)?:\/\/.+)$/i.exec(entry)
    const url = m ? m[2]! : entry
    const parsed = parseConnectionUrl(url)
    if (!parsed) {
      // Never print the entry or any part of it: a password can contain "/" and slip past any masking.
      console.warn(
        `[powdb] ignoring invalid connection #${index + 1} in POWDB_CONNECTIONS (passwords are not printed; check its postgres:// URL)`,
      )
      continue
    }
    out.push({
      id: crypto.randomUUID().slice(0, 8),
      name: m ? m[1]!.trim() : `${parsed.database} @ ${parsed.host}`,
      color: colors[out.length % colors.length]!,
      ...parsed,
      password: sealAtLoad(parsed.password || undefined),
      readOnly: false,
      production: false,
      aiAccess: 'read',
      createdAt: new Date().toISOString(),
    })
  }
  return out
}

function persist(data: StoreFile): Promise<void> {
  return writeJsonFile(connectionsFile(), data)
}

/**
 * The password to connect with. Managed connections read it from an environment variable
 * at connect time, so the secret never has to live in powdb.yaml or connections.json.
 * Stored passwords are decrypted here. A stored value that is not encrypted is refused (see decryptSecret).
 */
export function resolvePassword(conn: Pick<ConnectionConfig, 'password' | 'passwordEnv'>): string | undefined {
  if (conn.passwordEnv) return process.env[conn.passwordEnv] || undefined
  return conn.password === undefined ? undefined : decryptSecret(conn.password)
}

export function toInfo(c: ConnectionConfig): ConnectionInfo {
  const { password: _password, passwordEnv: _passwordEnv, ssh, ...rest } = c
  // Same rule as resolvePassword, without decrypting: a password that cannot be read still lists the connection.
  const hasPassword = c.passwordEnv ? Boolean(process.env[c.passwordEnv]) : Boolean(c.password)
  const info: ConnectionInfo = { ...rest, managed: c.managed === true, hasPassword }
  if (ssh) info.ssh = sshInfo(ssh)
  return info
}

export async function listConnections(): Promise<ConnectionConfig[]> {
  const data = await load()
  return [...data.connections].sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
}

export async function getConnection(id: string): Promise<ConnectionConfig> {
  const data = await load()
  const conn = data.connections.find((c) => c.id === id)
  if (!conn) throw new Error('Connection not found. It may have been deleted.')
  return conn
}

export async function createConnection(input: ConnectionInput): Promise<ConnectionConfig> {
  const data = await load()
  const conn: ConnectionConfig = {
    id: crypto.randomUUID().slice(0, 8),
    name: input.name.trim() || `${input.user}@${input.host}`,
    color: input.color,
    host: input.host.trim(),
    port: input.port,
    database: input.database.trim(),
    user: input.user.trim(),
    password: input.password ? encryptSecret(input.password) : undefined,
    ssl: input.ssl,
    readOnly: input.readOnly,
    production: input.production === true,
    aiAccess: input.aiAccess ?? 'read',
    createdAt: new Date().toISOString(),
  }
  const ssh = mergeSshInput(undefined, input.ssh, encryptSecret)
  if (ssh) conn.ssh = ssh
  data.connections.push(conn)
  await persist(data)
  return conn
}

export async function updateConnection(id: string, input: ConnectionInput): Promise<ConnectionConfig> {
  const data = await load()
  const index = data.connections.findIndex((c) => c.id === id)
  if (index === -1) throw new Error('Connection not found.')
  const prev = data.connections[index]!
  if (prev.managed) throw new Error(MANAGED_ERROR)
  const next: ConnectionConfig = {
    ...prev,
    name: input.name.trim() || prev.name,
    color: input.color,
    host: input.host.trim(),
    port: input.port,
    database: input.database.trim(),
    user: input.user.trim(),
    password: input.clearPassword ? undefined : input.password ? encryptSecret(input.password) : prev.password,
    ssl: input.ssl,
    readOnly: input.readOnly,
    production: input.production ?? prev.production === true,
    aiAccess: input.aiAccess ?? prev.aiAccess,
  }
  // undefined keeps the tunnel, null removes it
  const ssh = mergeSshInput(prev.ssh, input.ssh, encryptSecret)
  if (ssh) next.ssh = ssh
  else delete next.ssh
  data.connections[index] = next
  await persist(data)
  return next
}

export async function deleteConnection(id: string): Promise<void> {
  const data = await load()
  const conn = data.connections.find((c) => c.id === id)
  if (conn?.managed) throw new Error(MANAGED_ERROR)
  data.connections = data.connections.filter((c) => c.id !== id)
  await persist(data)
}

/** Stores the SSH host key seen on first use, so later connections can detect a changed server. */
export async function rememberHostKey(id: string, hostKey: string): Promise<void> {
  const data = await load()
  const conn = data.connections.find((c) => c.id === id)
  if (!conn?.ssh || conn.managed || conn.ssh.hostKey) return
  conn.ssh.hostKey = hostKey
  await persist(data)
}

export async function touchConnection(id: string): Promise<void> {
  const data = await load()
  const conn = data.connections.find((c) => c.id === id)
  if (!conn) return
  conn.lastUsedAt = new Date().toISOString()
  await persist(data)
}
