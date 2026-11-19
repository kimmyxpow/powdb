import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseAuthFile } from './auth.server'
import { parseStoreFile } from './store.server'

const dir = mkdtempSync(path.join(tmpdir(), 'powdb-files-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * Writes a data file in its own folder of the temp dir, named as the real file is (the error
 * messages use the file name), and returns its path and text the way the loaders read it.
 */
function writeData(
  folder: string,
  name: 'connections.json' | 'auth.json',
  text: string,
): { file: string; raw: string } {
  const file = path.join(dir, folder, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return { file, raw: readFileSync(file, 'utf8') }
}

const fullConnection = {
  id: 'prod',
  name: 'Production',
  color: 'rose',
  host: 'db.internal',
  port: 5432,
  database: 'app',
  user: 'app',
  password: 'enc:v1:AAAA:BBBB',
  passwordEnv: 'POWDB_PROD_PW',
  ssl: 'verify-full',
  readOnly: true,
  production: true,
  aiAccess: 'write',
  ssh: {
    host: 'bastion',
    port: 22,
    user: 'jump',
    auth: 'key',
    privateKey: 'enc:v1:CCCC:DDDD',
    hostKey: 'SHA256:abc',
  },
  managed: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  lastUsedAt: '2025-02-01T00:00:00.000Z',
}

describe('connections.json', () => {
  test('a current file loads with every field', () => {
    const { file, raw } = writeData(
      'current',
      'connections.json',
      JSON.stringify({ version: 1, connections: [fullConnection] }),
    )
    const [conn] = parseStoreFile(raw, file)
    expect(conn).toMatchObject({
      id: 'prod',
      color: 'rose',
      ssl: 'verify-full',
      production: true,
      aiAccess: 'write',
      ssh: { host: 'bastion', auth: 'key', hostKey: 'SHA256:abc' },
      lastUsedAt: '2025-02-01T00:00:00.000Z',
    })
  })

  test('the optional fields may be left out, and an empty list is fine', () => {
    const { ssh: _ssh, password: _pw, passwordEnv: _pe, lastUsedAt: _lu, managed: _m, ...minimal } = fullConnection
    const a = writeData('minimal', 'connections.json', JSON.stringify({ connections: [minimal] }))
    expect(parseStoreFile(a.raw, a.file)[0]).toMatchObject({ id: 'prod', production: true, aiAccess: 'write' })
    const b = writeData('empty', 'connections.json', '{"version":1,"connections":[]}')
    expect(parseStoreFile(b.raw, b.file)).toEqual([])
  })

  test('a connection missing a required field is refused, and the message names the field', () => {
    const { aiAccess: _dropped, ...noAi } = fullConnection
    const { file, raw } = writeData('missing-ai', 'connections.json', JSON.stringify({ connections: [noAi] }))
    expect(() => parseStoreFile(raw, file)).toThrow(`connections.json is not valid: ${file}: connections.0.aiAccess`)
  })

  test('an unknown aiAccess value is refused, not coerced', () => {
    const { file, raw } = writeData(
      'odd-ai',
      'connections.json',
      JSON.stringify({ connections: [{ ...fullConnection, aiAccess: 'maybe' }] }),
    )
    expect(() => parseStoreFile(raw, file)).toThrow('connections.0.aiAccess')
  })

  test('a corrupt field is refused with a message that names the file and the field, and the file is not changed', () => {
    const bad = writeData(
      'bad-port',
      'connections.json',
      JSON.stringify({ connections: [{ ...fullConnection, port: 'abc' }] }),
    )
    let message = ''
    try {
      parseStoreFile(bad.raw, bad.file)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message.startsWith(`connections.json is not valid: ${bad.file}: `)).toBe(true)
    expect(message).toContain('connections.0.port')
    expect(readFileSync(bad.file, 'utf8')).toBe(bad.raw)
  })

  test('invalid JSON is refused without echoing the file, so a password in it stays hidden', () => {
    const { file, raw } = writeData(
      'syntax',
      'connections.json',
      '{"connections":[{"id":"x","password":"hunter2-secret",}]',
    )
    let message = ''
    try {
      parseStoreFile(raw, file)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe(`connections.json is not valid: ${file}: the file is not valid JSON`)
    expect(message).not.toContain('hunter2')
  })
})

const token = {
  id: 'abcd1234',
  name: 'CI',
  prefix: 'powdb_abc123',
  scope: 'read',
  connections: 'all',
  createdAt: '2025-01-01T00:00:00.000Z',
  expiresAt: '2025-04-01T00:00:00.000Z',
  lastUsedAt: '2025-01-02T00:00:00.000Z',
  hash: 'f00d',
}

describe('auth.json', () => {
  test('a current file loads with the admin and the tokens', () => {
    const current = {
      version: 1,
      admin: { username: 'admin', passwordHash: '$argon2id$...', sessionVersion: 2 },
      secret: 'c2VjcmV0',
      localKey: 'bG9jYWw',
      tokens: [token, { ...token, id: 'scoped01', connections: ['prod'], scope: 'write', expiresAt: null }],
    }
    const { file, raw } = writeData('auth-current', 'auth.json', JSON.stringify(current))
    const data = parseAuthFile(raw, file)
    expect(data.admin).toEqual(current.admin)
    expect(data.tokens[1]?.connections).toEqual(['prod'])
    expect(data.tokens[1]?.expiresAt).toBeNull()
    expect(data.version).toBe(1)
  })

  test('a token without expiresAt is refused; null means it never expires', () => {
    const { expiresAt: _dropped, ...noExpiry } = token
    const missing = writeData(
      'auth-noexp',
      'auth.json',
      JSON.stringify({ version: 1, admin: null, secret: 's', localKey: 'k', tokens: [noExpiry] }),
    )
    expect(() => parseAuthFile(missing.raw, missing.file)).toThrow('tokens.0.expiresAt')
  })

  test('a corrupt file is refused by name, and the secret in it is not echoed', () => {
    const { file, raw } = writeData(
      'auth-bad',
      'auth.json',
      JSON.stringify({ version: 1, admin: null, secret: 'topsecret-value', localKey: 'k', tokens: [{ id: 1 }] }),
    )
    let message = ''
    try {
      parseAuthFile(raw, file)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message.startsWith(`auth.json is not valid: ${file}: `)).toBe(true)
    expect(message).toContain('tokens.0.id')
    expect(message).not.toContain('topsecret-value')
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })

  test('a file that is not JSON is refused without echoing it', () => {
    const { file, raw } = writeData('auth-syntax', 'auth.json', '{"secret": "leaky-value",')
    expect(() => parseAuthFile(raw, file)).toThrow(`auth.json is not valid: ${file}: the file is not valid JSON`)
    expect(() => parseAuthFile(raw, file)).not.toThrow('leaky-value')
  })
})
