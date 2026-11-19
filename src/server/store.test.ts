import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ConnectionInput } from '@/lib/types'

const dir = mkdtempSync(path.join(tmpdir(), 'powdb-store-'))
// Restored in afterAll: bun runs every test file in one process.
const savedEnv: Record<string, string | undefined> = {
  POWDB_DATA_DIR: process.env.POWDB_DATA_DIR,
  POWDB_CONFIG: process.env.POWDB_CONFIG,
  POWDB_CONNECTIONS: process.env.POWDB_CONNECTIONS,
  POWDB_TEST_PROD_PW: process.env.POWDB_TEST_PROD_PW,
}
process.env.POWDB_DATA_DIR = dir
delete process.env.POWDB_CONFIG
delete process.env.POWDB_CONNECTIONS
process.env.POWDB_TEST_PROD_PW = 'from-env'

// A connections file with one saved connection, plus a declarative managed connection.
writeFileSync(
  path.join(dir, 'connections.json'),
  JSON.stringify({
    version: 1,
    connections: [
      {
        id: 'saved1',
        name: 'Saved',
        color: 'blue',
        host: 'db.invalid',
        port: 1,
        database: 'd',
        user: 'u',
        ssl: 'disable',
        readOnly: false,
        production: false,
        aiAccess: 'read',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ],
  }),
)
writeFileSync(
  path.join(dir, 'powdb.yaml'),
  'connections:\n  - id: prod\n    url: postgres://app@db.invalid/app\n    password_env: POWDB_TEST_PROD_PW\n    read_only: true\n',
)

const store = await import('./store.server')

const input: ConnectionInput = {
  name: 'Scratch',
  color: 'blue',
  host: '127.0.0.1',
  port: 1,
  database: 'd',
  user: 'u',
  ssl: 'disable',
  readOnly: false,
  aiAccess: 'write',
}

describe('store with powdb.yaml and AI access', () => {
  test('managed connections load from powdb.yaml; saved connections keep their AI setting', async () => {
    const all = await store.listConnections()
    const prod = all.find((c) => c.id === 'prod')!
    expect(prod.managed).toBe(true)
    expect(prod.readOnly).toBe(true)
    expect(prod.aiAccess).toBe('read')
    expect(all.find((c) => c.id === 'saved1')?.aiAccess).toBe('read')
  })

  test('clients never see the password or the env var name', async () => {
    const prod = await store.getConnection('prod')
    const info = store.toInfo(prod)
    expect(info).not.toHaveProperty('password')
    expect(info).not.toHaveProperty('passwordEnv')
    expect(info.hasPassword).toBe(true)
    expect(info.managed).toBe(true)
    expect(JSON.stringify(info)).not.toContain('from-env')
    expect(store.resolvePassword(prod)).toBe('from-env')
    // the env value itself is never written to disk
    expect(readFileSync(path.join(dir, 'connections.json'), 'utf8')).not.toContain('from-env')
  })

  test('managed connections cannot be edited or deleted', async () => {
    await expect(store.updateConnection('prod', input)).rejects.toThrow(store.MANAGED_ERROR)
    await expect(store.deleteConnection('prod')).rejects.toThrow('Managed by powdb.yaml')
  })

  test('UI connections default to read for AI, and the setting can change', async () => {
    const created = await store.createConnection({ ...input, aiAccess: undefined })
    expect(created.aiAccess).toBe('read')
    const updated = await store.updateConnection(created.id, { ...input, aiAccess: 'write' })
    expect(updated.aiAccess).toBe('write')
    await store.deleteConnection(created.id)
    expect((await store.listConnections()).some((c) => c.id === created.id)).toBe(false)
  })

  test('production is off by default, and an update without it keeps the setting', async () => {
    const created = await store.createConnection({ ...input, aiAccess: undefined })
    expect(created.production).toBe(false)
    expect(store.toInfo(created).production).toBe(false)
    const marked = await store.updateConnection(created.id, { ...input, production: true })
    expect(marked.production).toBe(true)
    const kept = await store.updateConnection(created.id, { ...input, production: undefined })
    expect(kept.production).toBe(true)
    const unmarked = await store.updateConnection(created.id, { ...input, production: false })
    expect(unmarked.production).toBe(false)
    await store.deleteConnection(created.id)
  })

  test('a saved connection can be edited like any UI connection', async () => {
    const updated = await store.updateConnection('saved1', { ...input, aiAccess: 'off' })
    expect(updated.aiAccess).toBe('off')
  })
})

describe('a failed write does not block later writes', () => {
  afterEach(() => {
    process.env.POWDB_DATA_DIR = dir
  })

  test('after a write fails, the next write still succeeds and reaches the disk', async () => {
    // A regular file where a directory is expected: mkdir fails, so the write rejects.
    const blocker = path.join(dir, 'blocker-file')
    writeFileSync(blocker, 'not a directory')
    process.env.POWDB_DATA_DIR = path.join(blocker, 'sub')
    await expect(store.createConnection({ ...input, name: 'Lost' })).rejects.toThrow()

    process.env.POWDB_DATA_DIR = dir
    const saved = await store.createConnection({ ...input, name: 'Saved after failure' })
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'connections.json'), 'utf8')) as {
      connections: { id: string; name: string }[]
    }
    expect(onDisk.connections.some((c) => c.id === saved.id && c.name === 'Saved after failure')).toBe(true)
    await store.deleteConnection(saved.id)
  })
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('POWDB_CONNECTIONS warnings', () => {
  let seedDir: string
  let warn: ReturnType<typeof spyOn<Console, 'warn'>> | undefined

  afterEach(() => {
    warn?.mockRestore()
    warn = undefined
    process.env.POWDB_DATA_DIR = dir
    delete process.env.POWDB_CONNECTIONS
    rmSync(seedDir, { recursive: true, force: true })
  })

  test('an invalid entry is reported by number and its password is never printed', async () => {
    seedDir = mkdtempSync(path.join(tmpdir(), 'powdb-seed-'))
    process.env.POWDB_DATA_DIR = seedDir
    // The port is not a number, so the entry is invalid. The "/" in the password defeats the old masking regex.
    process.env.POWDB_CONNECTIONS = 'postgres://app:s3cret/pw@db:notaport/app'
    warn = spyOn(console, 'warn').mockImplementation(() => {})

    // A fresh module instance, so the seeding path runs again with an empty data dir.
    const spec = './store.server?seed-warning'
    const fresh = (await import(spec)) as typeof import('./store.server')
    await fresh.listConnections()

    const messages = warn.mock.calls.map((args) => args.map(String).join(' '))
    expect(messages.some((m) => m.includes('#1 in POWDB_CONNECTIONS'))).toBe(true)
    for (const m of messages) {
      expect(m).not.toContain('s3cret')
      expect(m).not.toContain('pw@')
      expect(m).not.toContain('db:notaport')
    }
  })

  // A restart reads the file the first start wrote, so a seeded connection must pass the file's own validation.
  test('seeded connections load again after a restart', async () => {
    seedDir = mkdtempSync(path.join(tmpdir(), 'powdb-seed-'))
    process.env.POWDB_DATA_DIR = seedDir
    process.env.POWDB_CONNECTIONS = 'Shop=postgresql://app:s3cret@db.invalid:5432/shop'

    const firstSpec = './store.server?seed-first-start'
    const first = (await import(firstSpec)) as typeof import('./store.server')
    const seeded = await first.listConnections()
    expect(seeded.map((c) => [c.name, c.production])).toEqual([['Shop', false]])

    const restartedSpec = './store.server?seed-restart'
    const restarted = (await import(restartedSpec)) as typeof import('./store.server')
    const loaded = await restarted.listConnections()
    expect(loaded.map((c) => [c.id, c.name, c.production])).toEqual([[seeded[0]!.id, 'Shop', false]])
  })
})
