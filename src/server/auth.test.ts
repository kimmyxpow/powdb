import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'powdb-auth-'))
// Restored in afterAll: bun runs every test file in one process.
const SAVED_ENV: Record<string, string | undefined> = {
  POWDB_DATA_DIR: process.env.POWDB_DATA_DIR,
  POWDB_AUTH: process.env.POWDB_AUTH,
  POWDB_ADMIN_PASSWORD: process.env.POWDB_ADMIN_PASSWORD,
  POWDB_SESSION_DAYS: process.env.POWDB_SESSION_DAYS,
}
process.env.POWDB_DATA_DIR = dir
delete process.env.POWDB_AUTH
delete process.env.POWDB_ADMIN_PASSWORD
delete process.env.POWDB_SESSION_DAYS

const auth = await import('./auth.server')
const { RateLimitError } = auth

let password = 'correct horse battery'

beforeAll(() => {
  process.env.POWDB_DATA_DIR = dir
})

afterAll(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

function signRaw(parts: string[]): string {
  const { secret } = JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf8')) as { secret: string }
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(parts.join('.')).digest('base64url')
}

function flipLastChar(value: string): string {
  return value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A')
}

describe('admin account and login', () => {
  test('first start needs setup; the admin password then logs in', async () => {
    expect(await auth.isSetupRequired()).toBe(true)
    await auth.setupAdmin('admin', password)
    expect(await auth.isSetupRequired()).toBe(false)
    await expect(auth.setupAdmin('someone', password)).rejects.toThrow('already exists')
    expect(await auth.verifyLogin('admin', 'wrong password', '198.51.100.1')).toBe(false)
    expect(await auth.verifyLogin('root', password, '198.51.100.1')).toBe(false)
    expect(await auth.verifyLogin('admin', password, '198.51.100.1')).toBe(true)
  })

  test('short passwords are refused', async () => {
    await expect(auth.setupAdmin('admin2', 'short')).rejects.toThrow('at least 8')
  })

  test('the password is stored as argon2id, never in clear text', () => {
    const file = readFileSync(path.join(dir, 'auth.json'), 'utf8')
    expect(file).not.toContain(password)
    expect(file).toContain('$argon2id$')
  })

  test('more than 10 failures from one IP in 15 minutes is rate limited, other IPs are not', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await auth.verifyLogin('admin', 'nope nope nope', '203.0.113.7')).toBe(false)
    }
    await expect(auth.verifyLogin('admin', password, '203.0.113.7')).rejects.toBeInstanceOf(RateLimitError)
    expect(await auth.verifyLogin('admin', password, '203.0.113.8')).toBe(true)
  })
})

describe('sessions', () => {
  test('valid, tampered, malformed and expired sessions', async () => {
    const { token, maxAgeSec } = await auth.issueSession()
    expect(maxAgeSec).toBe(30 * 86_400)
    expect(await auth.verifySession(token)).toBe(true)
    expect(await auth.verifySession(flipLastChar(token))).toBe(false)
    expect(await auth.verifySession(`${token}x`)).toBe(false)
    expect(await auth.verifySession(undefined)).toBe(false)

    // Same signing as the server, but with an expiry in the past.
    const past = [String(Date.now() - 60_000), '1', 'nonce']
    expect(await auth.verifySession([...past, signRaw(past)].join('.'))).toBe(false)
    // Control: the same helper signs a live session, so the expired result is about expiry.
    const live = [String(Date.now() + 60_000), '1', 'nonce']
    expect(await auth.verifySession([...live, signRaw(live)].join('.'))).toBe(true)
  })

  test('changing the password bumps sessionVersion and logs everyone out', async () => {
    const old = await auth.issueSession()
    await expect(auth.changePassword('not the password', 'another password')).rejects.toThrow('wrong')
    await auth.changePassword(password, 'another password')
    password = 'another password'
    expect(await auth.verifySession(old.token)).toBe(false)
    const fresh = await auth.issueSession()
    expect(await auth.verifySession(fresh.token)).toBe(true)
  })

  test('a session for an older sessionVersion is rejected', async () => {
    const stale = [String(Date.now() + 60_000), '1', 'nonce']
    expect(await auth.verifySession([...stale, signRaw(stale)].join('.'))).toBe(false)
  })
})

describe('API tokens and the local key', () => {
  test('create, verify, list without secrets, revoke', async () => {
    const created = await auth.createApiToken({
      name: 'ci bot',
      scope: 'write',
      connections: ['prod', 'prod', ' prod '],
    })
    expect(created.token).toMatch(/^powdb_[A-Za-z0-9]{32}$/)
    expect(created.info.prefix).toBe(created.token.slice(0, 12))
    expect(created.info.id).toHaveLength(8)
    expect(created.info.connections).toEqual(['prod'])

    const info = await auth.verifyApiToken(created.token)
    expect(info?.name).toBe('ci bot')
    expect(info?.scope).toBe('write')
    expect(await auth.verifyApiToken(flipLastChar(created.token))).toBeNull()
    expect(await auth.verifyApiToken('not-a-powdb-token')).toBeNull()

    const listed = await auth.listApiTokens()
    expect(listed.map((t) => t.id)).toContain(created.info.id)
    expect(JSON.stringify(listed)).not.toContain('hash')
    // only the SHA-256 of the token is on disk
    expect(readFileSync(path.join(dir, 'auth.json'), 'utf8')).not.toContain(created.token)

    await auth.revokeApiToken(created.info.id)
    expect(await auth.verifyApiToken(created.token)).toBeNull()
    await expect(auth.revokeApiToken(created.info.id)).rejects.toThrow('not found')
  })

  test('a token needs at least one connection unless it is for all', async () => {
    await expect(auth.createApiToken({ name: 'x', connections: [] })).rejects.toThrow('at least one')
    const all = await auth.createApiToken({ name: 'all', connections: 'all' })
    expect(all.info.connections).toBe('all')
  })

  test('local key matches only itself', async () => {
    expect(await auth.isLocalKey((await auth.getAuthFile()).localKey)).toBe(true)
    expect(await auth.isLocalKey('nope')).toBe(false)
  })

  test('POWDB_AUTH=off turns the login off', () => {
    process.env.POWDB_AUTH = 'off'
    expect(auth.authEnabled()).toBe(false)
    delete process.env.POWDB_AUTH
    expect(auth.authEnabled()).toBe(true)
  })
})

describe('failed sign-in memory', () => {
  test('failures outside the 15 minute window are forgotten, so the map does not grow', async () => {
    const start = Date.now()
    const clock = spyOn(Date, 'now').mockReturnValue(start)
    try {
      for (const ip of ['198.51.100.50', '198.51.100.51', '198.51.100.52']) {
        expect(await auth.verifyLogin('admin', 'nope nope nope', ip)).toBe(false)
      }
      expect(auth.trackedLoginIps()).toEqual(expect.arrayContaining(['198.51.100.50', '198.51.100.52']))
      clock.mockReturnValue(start + 16 * 60_000)
      expect(await auth.verifyLogin('admin', 'nope nope nope', '198.51.100.99')).toBe(false)
      expect(auth.trackedLoginIps()).toEqual(['198.51.100.99'])
    } finally {
      clock.mockRestore()
    }
  })

  test('the number of tracked IPs is capped; the least recently failed IP is dropped first', () => {
    const now = Date.now()
    const ipAt = (i: number) => `10.0.${Math.floor(i / 256)}.${i % 256}`
    for (let i = 0; i < 10_000; i++) auth.addLoginFailureForTest(ipAt(i), now)
    expect(auth.trackedLoginIps()).toHaveLength(10_000)
    // IP 0 fails again, so it is no longer the least recently failed
    auth.addLoginFailureForTest(ipAt(0), now)
    // one more IP is over the cap: IP 1 is now the oldest and goes
    auth.addLoginFailureForTest(ipAt(10_000), now)
    const tracked = auth.trackedLoginIps()
    expect(tracked).toHaveLength(10_000)
    expect(tracked).toContain(ipAt(0))
    expect(tracked).not.toContain(ipAt(1))
    expect(tracked).toContain(ipAt(10_000))
  })
})
