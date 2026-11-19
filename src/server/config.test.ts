import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadManagedConnections, parseConfigText } from './config.server'

const VALID = `
connections:
  - id: prod
    url: postgresql://app_ro:secret@db.internal:5432/app?sslmode=require
    password_env: PROD_PG_PASSWORD
    read_only: true
  - id: stage_1
    name: Staging
    url: postgres://reader@stage.internal/shop
    color: amber
    ai_access: write
`

describe('powdb.yaml parsing', () => {
  test('a valid file gives managed connections with defaults filled in', () => {
    const [prod, stage] = parseConfigText(VALID, 'powdb.yaml')
    expect(prod).toEqual({
      id: 'prod',
      name: 'app @ db.internal',
      color: 'neutral',
      host: 'db.internal',
      port: 5432,
      database: 'app',
      user: 'app_ro',
      password: 'secret',
      passwordEnv: 'PROD_PG_PASSWORD',
      ssl: 'require',
      readOnly: true,
      production: false,
      aiAccess: 'read',
      managed: true,
    })
    expect(stage).toMatchObject({
      id: 'stage_1',
      name: 'Staging',
      color: 'amber',
      port: 5432,
      database: 'shop',
      user: 'reader',
      password: undefined,
      passwordEnv: undefined,
      ssl: 'disable',
      readOnly: false,
      production: false,
      aiAccess: 'write',
      managed: true,
    })
  })

  test('an unknown key in a connection is refused, like any other unknown key', () => {
    const yaml = `
connections:
  - id: shop
    url: postgres://u@h/shop
    databases: [warehouse, analytics]
`
    expect(() => parseConfigText(yaml, 'powdb.yaml')).toThrow('databases')
    expect(() => parseConfigText(yaml, 'powdb.yaml')).toThrow('Unrecognized key')
  })

  test('an empty file means no connections', () => {
    expect(parseConfigText('', 'powdb.yaml')).toEqual([])
    expect(parseConfigText('connections: []', 'powdb.yaml')).toEqual([])
  })

  test('JSON files are accepted', () => {
    const json = JSON.stringify({ connections: [{ id: 'a', url: 'postgres://u@h/d' }] })
    expect(parseConfigText(json, 'powdb.json')[0]).toMatchObject({ id: 'a', database: 'd' })
  })

  test.each([
    ['an id with capitals or spaces', 'connections:\n  - id: Bad Id\n    url: postgres://u@h/d'],
    ['an empty id', 'connections:\n  - id: ""\n    url: postgres://u@h/d'],
    ['an invalid ai_access', 'connections:\n  - id: a\n    url: postgres://u@h/d\n    ai_access: admin'],
    ['a url that is not postgres', 'connections:\n  - id: a\n    url: mysql://u@h/d'],
    ['a misspelled key', 'connections:\n  - id: a\n    url: postgres://u@h/d\n    read-only: true'],
    ['a bad password_env name', 'connections:\n  - id: a\n    url: postgres://u@h/d\n    password_env: "not a name"'],
    ['duplicate ids', 'connections:\n  - id: a\n    url: postgres://u@h/d\n  - id: a\n    url: postgres://u@h/e'],
  ])('rejects %s', (_label, yaml) => {
    expect(() => parseConfigText(yaml, 'powdb.yaml')).toThrow()
  })
})

describe('loading the file from the data dir', () => {
  const made: string[] = []
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  })
  const freshDir = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'powdb-config-'))
    made.push(d)
    return d
  }

  test('a missing file is fine: no managed connections', async () => {
    const dir = freshDir()
    expect(await loadManagedConnections(dir)).toEqual([])
  })

  test('a valid file is read from the data dir', async () => {
    const dir = freshDir()
    writeFileSync(path.join(dir, 'powdb.yaml'), VALID)
    const loaded = await loadManagedConnections(dir)
    expect(loaded?.map((c) => c.id)).toEqual(['prod', 'stage_1'])
  })

  test('an invalid file is ignored (null), never a crash', async () => {
    const dir = freshDir()
    writeFileSync(path.join(dir, 'powdb.yaml'), 'connections:\n  - id: a\n    ai_access: nope\n')
    expect(await loadManagedConnections(dir)).toBeNull()
  })
})

describe('powdb.yaml ssh block', () => {
  const base = 'connections:\n  - id: prod\n    url: postgresql://app@db.internal:5432/app\n'

  test('a password_env login becomes a managed password tunnel, port 22 by default', () => {
    const [conn] = parseConfigText(
      `${base}    ssh:\n      host: bastion.example.com\n      user: deploy\n      password_env: BASTION_PW\n`,
      'powdb.yaml',
    )
    expect(conn!.ssh).toEqual({
      host: 'bastion.example.com',
      port: 22,
      user: 'deploy',
      auth: 'password',
      passwordEnv: 'BASTION_PW',
    })
    expect(conn!.host).toBe('db.internal')
  })

  test('a private_key_file login keeps the path and the optional passphrase_env and host_key', () => {
    const [conn] = parseConfigText(
      `${base}    ssh:\n      host: bastion.example.com\n      port: 2222\n      user: deploy\n      private_key_file: /run/secrets/bastion_key\n      passphrase_env: BASTION_KEY_PASS\n      host_key: SHA256:abcDEF123+/\n`,
      'powdb.yaml',
    )
    expect(conn!.ssh).toEqual({
      host: 'bastion.example.com',
      port: 2222,
      user: 'deploy',
      auth: 'key',
      privateKeyFile: '/run/secrets/bastion_key',
      passphraseEnv: 'BASTION_KEY_PASS',
      hostKey: 'SHA256:abcDEF123+/',
    })
  })

  test('a private_key_env login is a key tunnel too', () => {
    const [conn] = parseConfigText(
      `${base}    ssh:\n      host: b\n      user: u\n      private_key_env: BASTION_KEY\n`,
      'powdb.yaml',
    )
    expect(conn!.ssh).toMatchObject({ auth: 'key', privateKeyEnv: 'BASTION_KEY' })
  })

  test('a connection without ssh has no ssh key at all', () => {
    const [conn] = parseConfigText(base, 'powdb.yaml')
    expect(conn).not.toHaveProperty('ssh')
  })

  test.each([
    ['no login method', '      host: b\n      user: u\n'],
    ['two login methods', '      host: b\n      user: u\n      password_env: A\n      private_key_file: /k\n'],
    ['a password and a key env', '      host: b\n      user: u\n      password_env: A\n      private_key_env: K\n'],
    ['a passphrase with a password', '      host: b\n      user: u\n      password_env: A\n      passphrase_env: P\n'],
    ['a missing host', '      user: u\n      password_env: A\n'],
    ['a missing user', '      host: b\n      password_env: A\n'],
    ['a bad port', '      host: b\n      user: u\n      port: 70000\n      password_env: A\n'],
    ['a bad host_key', '      host: b\n      user: u\n      password_env: A\n      host_key: abc\n'],
    ['a misspelled ssh key', '      host: b\n      user: u\n      password_envv: A\n'],
    ['a bad env name', '      host: b\n      user: u\n      password_env: "not a name"\n'],
  ])('rejects an ssh block with %s', (_label, sshLines) => {
    expect(() => parseConfigText(`${base}    ssh:\n${sshLines}`, 'powdb.yaml')).toThrow()
  })
})
