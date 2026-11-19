import { randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { s } from '@/lib/schema'
import type { ApiTokenInfo, AuthState, TokenScope } from '@/lib/types'
import { parseDataFile, writeJsonFile } from './json-file.server'
import { dataDir } from './store.server'

/**
 * Login, sessions, API tokens and the local key. Everything lives in $POWDBS_DATA_DIR/auth.json
 * (mode 0600). Passwords are argon2id hashes, API tokens are stored as SHA-256 only.
 */
export const SESSION_COOKIE = 'powdbs_session'

const TOKEN_PREFIX = 'powdbs_'
const TOKEN_LENGTH = 32
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const MIN_PASSWORD = 8
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_LIMIT = 10
const LAST_USED_INTERVAL_MS = 60_000
const DAY_MS = 86_400_000
/** Tokens expire after this many days unless the caller says otherwise. */
const DEFAULT_TOKEN_DAYS = 90

interface AdminAccount {
  username: string
  passwordHash: string
  /** bumped on every password change; sessions carry the version they were issued for */
  sessionVersion: number
}

type StoredToken = ApiTokenInfo & { hash: string /* sha256 hex of the full token */ }

interface AuthFile {
  version: 1
  admin: AdminAccount | null
  /** base64, 32 random bytes: HMAC key for session tokens */
  secret: string
  /** base64url, 32 random bytes: lets the local CLI and the container in */
  localKey: string
  tokens: StoredToken[]
}

/** Checks auth.json on load. Fields the type marks optional may be missing. */
const adminSchema = s.object({
  username: s.string(),
  passwordHash: s.string(),
  sessionVersion: s.number(),
})
const storedTokenSchema = s.object({
  id: s.string(),
  name: s.string(),
  prefix: s.string(),
  scope: s.enum(['read', 'write', 'admin']),
  connections: s.union([s.literal('all'), s.array(s.string())]),
  createdAt: s.string(),
  /** null = never expires */
  expiresAt: s.string().nullable(),
  lastUsedAt: s.string().optional(),
  hash: s.string(),
})
const authFileSchema = s.object({
  admin: adminSchema.nullable(),
  secret: s.string(),
  localKey: s.string(),
  tokens: s.array(storedTokenSchema),
})

/** Parses and checks auth.json text. Throws a message that names the file, and never overwrites it. */
export function parseAuthFile(raw: string, file: string): AuthFile {
  return { ...parseDataFile(raw, file, authFileSchema), version: 1 as const }
}

/** Thrown when an IP has too many failed sign-ins. Routes answer 429. */
export class RateLimitError extends Error {
  retryAfterSec: number

  constructor(retryAfterSec: number) {
    super('Too many failed sign-in attempts. Try again later.')
    this.name = 'RateLimitError'
    this.retryAfterSec = retryAfterSec
  }
}

let cache: AuthFile | null = null
let loading: Promise<AuthFile> | null = null
/** failed sign-in times per IP, in memory only (a restart clears them) */
const failures = new Map<string, number[]>()
/** At most this many IPs are tracked. When full, the least recently failed IP is dropped. */
const MAX_TRACKED_IPS = 10_000
/** Entries whose window has passed are swept at most this often. */
const SWEEP_INTERVAL_MS = 60_000
let lastSweep = 0

/** Drops the IPs whose failures are all outside the window. Cheap: runs at most once per interval. */
function sweepFailures(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = now
  for (const [ip, times] of failures) {
    const recent = times.filter((t) => now - t < LOGIN_WINDOW_MS)
    if (recent.length) failures.set(ip, recent)
    else failures.delete(ip)
  }
}

function setFailures(ip: string, times: number[]): void {
  // Delete first, so a re-set IP moves to the end: the first key is then the least recently failed.
  failures.delete(ip)
  failures.set(ip, times)
  while (failures.size > MAX_TRACKED_IPS) {
    const oldest = failures.keys().next().value
    if (oldest === undefined) break
    failures.delete(oldest)
  }
}

/** For tests: the IPs currently tracked for failed sign-ins, least recently failed first. */
export function trackedLoginIps(): string[] {
  return [...failures.keys()]
}

/** For tests: records one failed sign-in for an IP at a given time, without the password check. */
export function addLoginFailureForTest(ip: string, at: number): void {
  setFailures(ip, [...(failures.get(ip) ?? []), at])
}

export function authEnabled(): boolean {
  return process.env.POWDBS_AUTH !== 'off'
}

function authFile(): string {
  return path.join(dataDir(), 'auth.json')
}

function freshFile(): AuthFile {
  return {
    version: 1,
    admin: null,
    secret: randomBytes(32).toString('base64'),
    localKey: randomBytes(32).toString('base64url'),
    tokens: [],
  }
}

export async function getAuthFile(): Promise<AuthFile> {
  if (cache) return cache
  // Concurrent first calls share one load, so the env admin is seeded only once.
  loading ??= loadAuthFile()
    .then((data) => {
      cache = data
      return data
    })
    .finally(() => {
      loading = null
    })
  return loading
}

async function loadAuthFile(): Promise<AuthFile> {
  let raw: string | null = null
  try {
    raw = await Bun.file(authFile()).text()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  let data: AuthFile
  if (raw === null) {
    data = freshFile()
    await persist(data)
  } else {
    data = parseAuthFile(raw, authFile())
  }
  await seedAdminFromEnv(data)
  return data
}

/** POWDBS_ADMIN_USER / POWDBS_ADMIN_PASSWORD: create the admin when none exists yet. */
async function seedAdminFromEnv(data: AuthFile): Promise<void> {
  const password = process.env.POWDBS_ADMIN_PASSWORD
  if (!password || data.admin) return
  if (password.length < MIN_PASSWORD) {
    console.warn(`[powdbs] POWDBS_ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters; no admin created`)
    return
  }
  const username = envAdminUsername()
  data.admin = { username, passwordHash: await hashPassword(password), sessionVersion: 1 }
  await persist(data)
  console.log(`[powdbs] created admin account "${username}" from POWDBS_ADMIN_PASSWORD`)
}

function envAdminUsername(): string {
  return cleanUsername(process.env.POWDBS_ADMIN_USER ?? 'admin')
}

function persist(data: AuthFile): Promise<void> {
  return writeJsonFile(authFile(), data)
}

export async function isSetupRequired(): Promise<boolean> {
  if (!authEnabled()) return false
  return (await getAuthFile()).admin === null
}

function cleanUsername(username: string): string {
  const name = username.trim()
  if (!name || name.length > 64) throw new Error('Username must be 1-64 characters.')
  return name
}

async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`)
  }
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

export async function setupAdmin(username: string, password: string): Promise<void> {
  const name = cleanUsername(username)
  // Hash first, then check and set without awaiting in between, so two setups cannot both win.
  const passwordHash = await hashPassword(password)
  const data = await getAuthFile()
  if (data.admin) throw new Error('An admin account already exists.')
  data.admin = { username: name, passwordHash, sessionVersion: 1 }
  await persist(data)
}

/**
 * Check a sign-in. More than 10 failures from one IP in 15 minutes throws RateLimitError
 * before any password check. A success clears that IP's failures.
 */
export async function verifyLogin(username: string, password: string, ip: string): Promise<boolean> {
  const now = Date.now()
  sweepFailures(now)
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS)
  if (recent.length === 0) failures.delete(ip)
  else failures.set(ip, recent)
  if (recent.length >= LOGIN_LIMIT) {
    throw new RateLimitError(Math.ceil((recent[0]! + LOGIN_WINDOW_MS - now) / 1000))
  }

  const data = await getAuthFile()
  const admin = data.admin
  const passwordOk = admin ? await Bun.password.verify(password, admin.passwordHash) : false
  const userOk = admin !== null && username.trim() === admin.username
  if (passwordOk && userOk) {
    failures.delete(ip)
    return true
  }
  setFailures(ip, [...recent, now])
  return false
}

export async function changePassword(current: string, next: string): Promise<void> {
  const data = await getAuthFile()
  if (!data.admin) throw new Error('No admin account yet.')
  if (!(await Bun.password.verify(current, data.admin.passwordHash))) {
    throw new Error('Current password is wrong.')
  }
  const passwordHash = await hashPassword(next)
  data.admin.passwordHash = passwordHash
  data.admin.sessionVersion += 1
  await persist(data)
}

export interface IssuedSession {
  token: string
  maxAgeSec: number
}

const SIGN_IN_OFF = 'Sign-in is turned off (POWDBS_AUTH=off).'
const ALREADY_SET_UP = 'An admin account already exists. Sign in instead.'

export async function authState(sessionToken: string | null | undefined): Promise<AuthState> {
  const enabled = authEnabled()
  const setupRequired = await isSetupRequired()
  let authenticated = !enabled
  let username: string | null = null
  if (enabled && !setupRequired && (await verifySession(sessionToken))) {
    authenticated = true
    username = (await getAuthFile()).admin!.username
  }
  return { authEnabled: enabled, setupRequired, authenticated, username }
}

/** Checks a sign-in and starts a session. Rate limits apply as in verifyLogin. */
export async function signIn(username: string, password: string, ip: string): Promise<IssuedSession> {
  if (!authEnabled()) throw new Error(SIGN_IN_OFF)
  if (!(await verifyLogin(username, password, ip))) throw new Error('Wrong username or password.')
  return issueSession()
}

/** Creates the first admin (only while none exists) and starts a session for it. */
export async function setUpFirstAdmin(username: string, password: string): Promise<IssuedSession> {
  if (!authEnabled()) throw new Error(SIGN_IN_OFF)
  if (!(await isSetupRequired())) throw new Error(ALREADY_SET_UP)
  try {
    await setupAdmin(username, password)
  } catch (err) {
    if (err instanceof Error && err.message === 'An admin account already exists.') throw new Error(ALREADY_SET_UP)
    throw err
  }
  return issueSession()
}

/**
 * Changes the admin password for a signed-in session. The current password must match.
 * The returned session replaces the caller's cookie: every older session is now invalid.
 */
export async function changeOwnPassword(
  sessionToken: string | null | undefined,
  current: string,
  next: string,
): Promise<IssuedSession> {
  if (!authEnabled()) throw new Error(SIGN_IN_OFF)
  if (!(await verifySession(sessionToken))) throw new Error('Sign in to change the password.')
  await changePassword(current, next)
  return issueSession()
}

/** Used by `powdbs admin reset-password` (local key only). Creates the admin if there is none. */
export async function resetAdminPassword(next: string): Promise<void> {
  const passwordHash = await hashPassword(next)
  const data = await getAuthFile()
  if (data.admin) {
    data.admin.passwordHash = passwordHash
    data.admin.sessionVersion += 1
  } else {
    data.admin = { username: envAdminUsername(), passwordHash, sessionVersion: 1 }
  }
  await persist(data)
}

function sessionDays(): number {
  const days = Number(process.env.POWDBS_SESSION_DAYS)
  return Number.isFinite(days) && days > 0 ? days : 30
}

function sign(data: AuthFile, parts: string[]): string {
  return new Bun.CryptoHasher('sha256', Buffer.from(data.secret, 'base64')).update(parts.join('.')).digest('base64url')
}

/** Constant-time string compare (length is not secret). */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Session token: `${expiresMs}.${sessionVersion}.${nonce}.${sig}`, signed with the stored secret. */
export async function issueSession(): Promise<{ token: string; maxAgeSec: number }> {
  const data = await getAuthFile()
  if (!data.admin) throw new Error('No admin account yet.')
  const maxAgeSec = sessionDays() * 86_400
  const expires = String(Date.now() + maxAgeSec * 1000)
  const parts = [expires, String(data.admin.sessionVersion), randomBytes(16).toString('base64url')]
  return { token: [...parts, sign(data, parts)].join('.'), maxAgeSec }
}

export async function verifySession(token: string | null | undefined): Promise<boolean> {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 4) return false
  const [expires, version, nonce, sig] = parts as [string, string, string, string]
  const data = await getAuthFile()
  if (!data.admin) return false
  if (!/^\d+$/.test(expires) || Number(expires) <= Date.now()) return false
  if (version !== String(data.admin.sessionVersion)) return false
  return safeEqual(sig, sign(data, [expires, version, nonce]))
}

/** The local key from the CLI / container (X-PowDBs-Local-Key). */
export async function isLocalKey(candidate: string): Promise<boolean> {
  const data = await getAuthFile()
  return safeEqual(candidate, data.localKey)
}

const BASE62_LIMIT = 248 // 62 * 4: bytes below this map to base62 without bias

function randomBase62(length: number): string {
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < BASE62_LIMIT && out.length < length) out += BASE62[byte % 62]
    }
  }
  return out
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}

function publicInfo(t: StoredToken): ApiTokenInfo {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    connections: t.connections,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    ...(t.lastUsedAt ? { lastUsedAt: t.lastUsedAt } : {}),
  }
}

/**
 * expiresInDays: a positive whole number of days, or null for a token that never expires.
 * Omitted means DEFAULT_TOKEN_DAYS.
 */
export async function createApiToken({
  name,
  scope = 'read',
  connections = 'all',
  expiresInDays = DEFAULT_TOKEN_DAYS,
}: {
  name: string
  scope?: TokenScope
  connections?: 'all' | string[]
  expiresInDays?: number | null
}): Promise<{ token: string; info: ApiTokenInfo }> {
  const label = name.trim()
  if (!label || label.length > 80) throw new Error('Token name must be 1-80 characters.')
  if (scope !== 'read' && scope !== 'write' && scope !== 'admin') throw new Error('Unknown token scope.')
  const ids = connections === 'all' ? 'all' : [...new Set(connections.map((c) => c.trim()).filter(Boolean))]
  if (ids !== 'all' && ids.length === 0) throw new Error('Choose at least one connection, or allow all.')
  if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1)) {
    throw new Error('Expiry must be a whole number of days, or never.')
  }

  const token = TOKEN_PREFIX + randomBase62(TOKEN_LENGTH)
  const now = Date.now()
  const info: ApiTokenInfo = {
    id: randomBytes(6).toString('base64url'), // 8 characters
    name: label,
    prefix: token.slice(0, 12),
    scope,
    connections: ids,
    createdAt: new Date(now).toISOString(),
    expiresAt: expiresInDays === null ? null : new Date(now + expiresInDays * DAY_MS).toISOString(),
  }
  const data = await getAuthFile()
  data.tokens.push({ ...info, hash: hashToken(token) })
  await persist(data)
  return { token, info }
}

export async function listApiTokens(): Promise<ApiTokenInfo[]> {
  const data = await getAuthFile()
  return data.tokens.map(publicInfo).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function revokeApiToken(id: string): Promise<void> {
  const data = await getAuthFile()
  const index = data.tokens.findIndex((t) => t.id === id)
  if (index === -1) throw new Error('Token not found.')
  data.tokens.splice(index, 1)
  await persist(data)
}

/**
 * Returns the token's info when valid. Expired tokens are rejected but stay listed until
 * revoked. lastUsedAt is written at most once a minute.
 */
export async function verifyApiToken(token: string): Promise<ApiTokenInfo | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const data = await getAuthFile()
  const hash = hashToken(token)
  const stored = data.tokens.find((t) => safeEqual(t.hash, hash))
  if (!stored) return null
  const now = Date.now()
  if (stored.expiresAt && Date.parse(stored.expiresAt) <= now) return null
  if (!stored.lastUsedAt || now - Date.parse(stored.lastUsedAt) >= LAST_USED_INTERVAL_MS) {
    stored.lastUsedAt = new Date(now).toISOString()
    persist(data).catch((err: Error) => console.warn(`[powdbs] could not save token use: ${err.message}`))
  }
  return publicInfo(stored)
}
