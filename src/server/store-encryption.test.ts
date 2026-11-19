import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ISOLATED, runInChildProcess } from './http/test-process'

// Stateful (connections.json is cached in the store module): runs in a child process.
if (!ISOLATED) {
  test('saved password encryption passes in an isolated process', () => runInChildProcess(import.meta.path), 120_000)
} else {
  const dir = process.env.POWDB_DATA_DIR!
  const file = path.join(dir, 'connections.json')
  const REFUSED = 'A stored secret is not encrypted. Save it again.'
  // A connection whose password is in clear text. Nothing converts it: it has to be saved again.
  const plainStored = JSON.stringify({
    version: 1,
    connections: [
      {
        id: 'demo1',
        name: 'Demo',
        color: 'blue',
        host: '127.0.0.1',
        port: 1,
        database: 'shop',
        user: 'demo',
        password: 'demo',
        ssl: 'disable',
        readOnly: false,
        production: false,
        aiAccess: 'read',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  })
  writeFileSync(file, plainStored)
  const store = await import('@/server/store.server')

  describe('a clear-text stored password', () => {
    test('is not rewritten on load, and no backup is made', async () => {
      const [conn] = await store.listConnections()
      expect(conn!.id).toBe('demo1')
      expect(readFileSync(file, 'utf8')).toBe(plainStored)
      expect(existsSync(path.join(dir, 'connections.backup-before-encryption.json'))).toBe(false)
    })

    test('is listed, but resolving it is refused with the save-again message', async () => {
      const [conn] = await store.listConnections()
      expect(store.toInfo(conn!).hasPassword).toBe(true)
      expect(() => store.resolvePassword(conn!)).toThrow(REFUSED)
    })
  })

  describe('new passwords', () => {
    test('a password saved through the store is stored encrypted, in a file only its owner can read', async () => {
      const created = await store.createConnection({
        name: 'Scratch',
        color: 'blue',
        host: '127.0.0.1',
        port: 1,
        database: 'd',
        user: 'u',
        password: 'fresh-secret',
        ssl: 'disable',
        readOnly: false,
        aiAccess: 'read',
      })
      expect(created.password!.startsWith('enc:v1:')).toBe(true)
      expect(readFileSync(file, 'utf8')).not.toContain('fresh-secret')
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(store.resolvePassword(created)).toBe('fresh-secret')

      const kept = await store.updateConnection(created.id, {
        name: 'Scratch',
        color: 'blue',
        host: '127.0.0.1',
        port: 1,
        database: 'd',
        user: 'u',
        ssl: 'disable',
        readOnly: false,
      })
      expect(store.resolvePassword(kept)).toBe('fresh-secret')
    })
  })
}
