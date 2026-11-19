import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ConnectionInput } from '@/lib/types'
import { ISOLATED, runInChildProcess } from './http/test-process'

// The store keeps connections in module state, so this runs in a child process with its own data dir.
if (!ISOLATED) {
  test(
    'SSH tunnel secrets are encrypted and never returned, in an isolated process',
    () => runInChildProcess(import.meta.path),
    120_000,
  )
} else {
  const dir = process.env.POWVIEW_DATA_DIR!
  const file = path.join(dir, 'connections.json')
  const store = await import('@/server/store.server')
  const { decryptSecret } = await import('./secret.server')

  const KEY_TEXT = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key-body\n-----END OPENSSH PRIVATE KEY-----\n'
  const base: ConnectionInput = {
    name: 'Behind bastion',
    color: 'blue',
    host: 'db.internal',
    port: 5432,
    database: 'app',
    user: 'app',
    ssl: 'disable',
    readOnly: false,
    aiAccess: 'read',
  }

  describe('SSH tunnel secrets', () => {
    test('a password is stored encrypted, decrypts back, and is not shown by toInfo', async () => {
      const created = await store.createConnection({
        ...base,
        ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', password: 'ssh-pw-123456' },
      })
      expect(created.ssh?.password?.startsWith('enc:v1:')).toBe(true)
      expect(decryptSecret(created.ssh!.password!)).toBe('ssh-pw-123456')
      expect(readFileSync(file, 'utf8')).not.toContain('ssh-pw-123456')

      const info = store.toInfo(created)
      expect(info.ssh).toEqual({
        host: 'bastion.example.com',
        port: 22,
        user: 'deploy',
        auth: 'password',
        hasPassword: true,
        hasKey: false,
      })
      expect(JSON.stringify(info)).not.toContain('enc:v1')
      expect(info).not.toHaveProperty('password')
    })

    test('a private key and its passphrase are stored encrypted', async () => {
      const created = await store.createConnection({
        ...base,
        name: 'Key bastion',
        ssh: {
          host: 'bastion.example.com',
          port: 2222,
          user: 'ops',
          auth: 'key',
          privateKey: KEY_TEXT,
          passphrase: 'phrase-xyz',
        },
      })
      expect(decryptSecret(created.ssh!.privateKey!)).toBe(KEY_TEXT)
      expect(decryptSecret(created.ssh!.passphrase!)).toBe('phrase-xyz')
      const onDisk = readFileSync(file, 'utf8')
      expect(onDisk).not.toContain('secret-key-body')
      expect(onDisk).not.toContain('phrase-xyz')
      expect(store.toInfo(created).ssh).toMatchObject({ auth: 'key', hasKey: true, hasPassword: false })
    })

    test('an empty secret on update keeps the stored one, a typed one replaces it', async () => {
      const created = await store.createConnection({
        ...base,
        name: 'Keep test',
        ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', password: 'first-pw-000000' },
      })
      const kept = await store.updateConnection(created.id, {
        ...base,
        name: 'Keep test',
        ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', password: '' },
      })
      expect(kept.ssh?.password).toBe(created.ssh?.password)

      const replaced = await store.updateConnection(created.id, {
        ...base,
        name: 'Keep test',
        ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', password: 'second-pw-111111' },
      })
      expect(decryptSecret(replaced.ssh!.password!)).toBe('second-pw-111111')
    })

    test('leaving ssh out on update keeps the tunnel, null removes it', async () => {
      const created = await store.createConnection({
        ...base,
        name: 'Remove test',
        ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', password: 'rm-pw-222222' },
      })
      const kept = await store.updateConnection(created.id, { ...base, name: 'Remove test' })
      expect(kept.ssh?.host).toBe('bastion.example.com')

      const removed = await store.updateConnection(created.id, { ...base, name: 'Remove test', ssh: null })
      expect(removed.ssh).toBeUndefined()
      expect(store.toInfo(removed)).not.toHaveProperty('ssh')
    })

    test('the first host key seen is remembered once and never overwritten', async () => {
      const created = await store.createConnection({
        ...base,
        name: 'Host key test',
        ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', password: 'hk-pw-333333' },
      })
      await store.rememberHostKey(created.id, 'SHA256:first')
      await store.rememberHostKey(created.id, 'SHA256:second')
      const [saved] = (await store.listConnections()).filter((c) => c.id === created.id)
      expect(saved?.ssh?.hostKey).toBe('SHA256:first')
      expect(store.toInfo(saved!).ssh?.hostKey).toBe('SHA256:first')
    })

    test('a connection without a tunnel ignores remembered host keys', async () => {
      const created = await store.createConnection({ ...base, name: 'No ssh' })
      await store.rememberHostKey(created.id, 'SHA256:nope')
      const [saved] = (await store.listConnections()).filter((c) => c.id === created.id)
      expect(saved?.ssh).toBeUndefined()
    })
  })
}
