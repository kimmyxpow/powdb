import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ConnectionConfig, ConnectionInput } from '@/lib/types'
import { draftConnection } from './draft-connection'
import { decryptSecret, encryptSecret } from './secret.server'
import { resolvePassword } from './store.server'

const input: ConnectionInput = {
  name: 'Dev',
  color: 'blue',
  host: 'db.internal',
  port: 5432,
  database: 'app',
  user: 'ann',
  ssl: 'disable',
  readOnly: false,
}

const saved: ConnectionConfig = {
  id: 'c1',
  name: 'Dev',
  color: 'blue',
  host: 'db.internal',
  port: 5432,
  database: 'app',
  user: 'ann',
  password: 'enc:v1:stored-iv:stored-body',
  ssl: 'disable',
  readOnly: false,
  production: false,
  aiAccess: 'read',
  createdAt: '2026-01-01T00:00:00.000Z',
}

/** A fake seal that records what it was asked to encrypt. */
function fakeSeal() {
  const calls: string[] = []
  const seal = (plain: string) => {
    calls.push(plain)
    return `SEALED(${plain})`
  }
  return { seal, calls }
}

describe('draftConnection: database password', () => {
  test('a typed password is sealed', () => {
    const { seal, calls } = fakeSeal()
    const draft = draftConnection(saved, { ...input, password: 'typed' }, seal)
    expect(draft.password).toBe('SEALED(typed)')
    expect(calls).toEqual(['typed'])
  })

  test('a typed password is sealed for a new connection too', () => {
    const { seal } = fakeSeal()
    expect(draftConnection(null, { ...input, password: 'typed' }, seal).password).toBe('SEALED(typed)')
  })

  test('without a typed password, the saved encrypted password is kept as stored and not decrypted', () => {
    const { seal, calls } = fakeSeal()
    const draft = draftConnection(saved, input, seal)
    expect(draft.password).toBe('enc:v1:stored-iv:stored-body')
    expect(calls).toEqual([])
  })

  test('a typed password wins over a saved passwordEnv, which is then left out', () => {
    const { seal } = fakeSeal()
    const managed = { ...saved, password: undefined, passwordEnv: 'DEV_PASSWORD' }
    const draft = draftConnection(managed, { ...input, password: 'typed' }, seal)
    expect(draft.password).toBe('SEALED(typed)')
    expect(draft.passwordEnv).toBeUndefined()
  })

  test('a saved passwordEnv is kept, for a managed connection', () => {
    const { seal, calls } = fakeSeal()
    const managed = { ...saved, password: undefined, passwordEnv: 'DEV_PASSWORD' }
    const draft = draftConnection(managed, input, seal)
    expect(draft.passwordEnv).toBe('DEV_PASSWORD')
    expect(draft.password).toBeUndefined()
    expect(calls).toEqual([])
  })

  test('clearPassword removes the saved password and passwordEnv', () => {
    const { seal, calls } = fakeSeal()
    const draft = draftConnection(saved, { ...input, clearPassword: true }, seal)
    expect(draft.password).toBeUndefined()
    expect(draft.passwordEnv).toBeUndefined()
    const managed = { ...saved, password: undefined, passwordEnv: 'DEV_PASSWORD' }
    expect(draftConnection(managed, { ...input, clearPassword: true }, seal).passwordEnv).toBeUndefined()
    expect(calls).toEqual([])
  })

  test('no password anywhere gives no password', () => {
    const { seal } = fakeSeal()
    expect(draftConnection(null, input, seal).password).toBeUndefined()
  })

  test('the plain fields are copied, with the draft defaults', () => {
    const { seal } = fakeSeal()
    const draft = draftConnection(null, input, seal)
    expect(draft).toMatchObject({
      id: 'test',
      host: 'db.internal',
      port: 5432,
      database: 'app',
      user: 'ann',
      production: false,
      aiAccess: 'read',
      createdAt: '',
    })
    expect(draft.ssh).toBeUndefined()
  })
})

describe('draftConnection: SSH secrets', () => {
  const sshPassword = { host: 'bastion', port: 22, user: 'jump', auth: 'password' as const }
  const sshKey = { host: 'bastion', port: 22, user: 'jump', auth: 'key' as const }

  test('a new SSH password is sealed with the same seal', () => {
    const { seal, calls } = fakeSeal()
    const draft = draftConnection(null, { ...input, ssh: { ...sshPassword, password: 'hop' } }, seal)
    expect(draft.ssh?.password).toBe('SEALED(hop)')
    expect(calls).toEqual(['hop'])
  })

  test('a new SSH private key and passphrase are sealed with the same seal', () => {
    const { seal, calls } = fakeSeal()
    const draft = draftConnection(null, { ...input, ssh: { ...sshKey, privateKey: 'PEM', passphrase: 'phrase' } }, seal)
    expect(draft.ssh?.privateKey).toBe('SEALED(PEM)')
    expect(draft.ssh?.passphrase).toBe('SEALED(phrase)')
    expect(calls).toEqual(['PEM', 'phrase'])
  })

  test('a saved SSH password is kept as stored when no new one is typed', () => {
    const { seal, calls } = fakeSeal()
    const withSsh: ConnectionConfig = { ...saved, ssh: { ...sshPassword, password: 'enc:v1:ssh-stored' } }
    const draft = draftConnection(withSsh, { ...input, ssh: { ...sshPassword } }, seal)
    expect(draft.ssh?.password).toBe('enc:v1:ssh-stored')
    expect(calls).toEqual([])
  })

  test('ssh null removes the tunnel from the draft', () => {
    const { seal } = fakeSeal()
    const withSsh: ConnectionConfig = { ...saved, ssh: { ...sshPassword, password: 'enc:v1:ssh-stored' } }
    expect(draftConnection(withSsh, { ...input, ssh: null }, seal).ssh).toBeUndefined()
  })
})

describe('draftConnection with the real encryption', () => {
  let dir: string
  const savedEnv = { dir: process.env.POWVIEW_DATA_DIR, secret: process.env.POWVIEW_SECRET }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'powview-draft-'))
    process.env.POWVIEW_DATA_DIR = dir
    delete process.env.POWVIEW_SECRET
  })

  afterAll(() => {
    if (savedEnv.dir === undefined) delete process.env.POWVIEW_DATA_DIR
    else process.env.POWVIEW_DATA_DIR = savedEnv.dir
    if (savedEnv.secret === undefined) delete process.env.POWVIEW_SECRET
    else process.env.POWVIEW_SECRET = savedEnv.secret
    rmSync(dir, { recursive: true, force: true })
  })

  test('a typed password resolves back to itself through resolvePassword', () => {
    const draft = draftConnection(null, { ...input, password: 'typed#p@ss/w?rd:x' }, encryptSecret)
    expect(draft.password).not.toContain('typed')
    expect(resolvePassword(draft)).toBe('typed#p@ss/w?rd:x')
  })

  test('a saved encrypted password resolves through resolvePassword when no new one is typed', () => {
    const stored = { ...saved, password: encryptSecret('s3cret') }
    const draft = draftConnection(stored, input, encryptSecret)
    expect(resolvePassword(draft)).toBe('s3cret')
  })

  test('a typed SSH password is sealed and decrypts back to itself', () => {
    const draft = draftConnection(
      null,
      { ...input, ssh: { host: 'bastion', port: 22, user: 'jump', auth: 'password', password: 'hop-pw' } },
      encryptSecret,
    )
    expect(draft.ssh?.password).not.toContain('hop-pw')
    expect(decryptSecret(draft.ssh!.password!)).toBe('hop-pw')
  })
})
