import { describe, expect, test } from 'bun:test'
import type { SshInput, SshSettings } from '@/lib/types'
import { formatHostKeyFingerprint, mergeSshInput, sshInfo, tunnelKey, type ResolvedSsh } from './ssh-settings'

/** Stands in for encryptSecret: the stored value is recognisable, the plain text is not kept. */
const seal = (plain: string) => `sealed:${plain}`

const KEY_TEXT = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n'

function input(overrides: Partial<SshInput> = {}): SshInput {
  return { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'password', ...overrides }
}

function saved(overrides: Partial<SshSettings> = {}): SshSettings {
  return {
    host: 'bastion.example.com',
    port: 22,
    user: 'deploy',
    auth: 'password',
    password: 'sealed:old',
    ...overrides,
  }
}

describe('formatHostKeyFingerprint', () => {
  test('prints the digest in base64 without padding, prefixed with SHA256:', () => {
    const hex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    expect(formatHostKeyFingerprint(hex)).toBe('SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')
  })

  test('a digest whose base64 needs padding loses the trailing "="', () => {
    // 1 byte: base64 "AA==" becomes "AA"
    expect(formatHostKeyFingerprint('00')).toBe('SHA256:AA')
  })
})

describe('tunnelKey', () => {
  const base: ResolvedSsh = { host: 'b', port: 22, user: 'u', auth: 'password', password: 'p' }

  test('the same settings and target give the same key', () => {
    expect(tunnelKey({ ...base }, 'db', 5432)).toBe(tunnelKey({ ...base }, 'db', 5432))
  })

  test('a changed password, SSH port, user or database target gives another key', () => {
    const key = tunnelKey(base, 'db', 5432)
    expect(tunnelKey({ ...base, password: 'q' }, 'db', 5432)).not.toBe(key)
    expect(tunnelKey({ ...base, port: 2222 }, 'db', 5432)).not.toBe(key)
    expect(tunnelKey({ ...base, user: 'other' }, 'db', 5432)).not.toBe(key)
    expect(tunnelKey(base, 'other-db', 5432)).not.toBe(key)
    expect(tunnelKey(base, 'db', 5433)).not.toBe(key)
  })

  test('a pinned host key does not change the key (remembering it must not restart the tunnel)', () => {
    expect(tunnelKey({ ...base, hostKey: 'SHA256:abc' }, 'db', 5432)).toBe(tunnelKey(base, 'db', 5432))
  })

  test('the key is not the secret itself', () => {
    expect(tunnelKey({ ...base, password: 'very-secret-value' }, 'db', 5432)).not.toContain('very-secret-value')
  })
})

describe('mergeSshInput: creating and removing', () => {
  test('undefined input keeps the tunnel as it is', () => {
    const prev = saved()
    expect(mergeSshInput(prev, undefined, seal)).toBe(prev)
    expect(mergeSshInput(undefined, undefined, seal)).toBeUndefined()
  })

  test('null input removes the tunnel', () => {
    expect(mergeSshInput(saved(), null, seal)).toBeUndefined()
  })

  test('a new password tunnel is sealed and trims host and user', () => {
    const out = mergeSshInput(undefined, input({ host: '  bastion  ', user: ' deploy ', password: 'pw' }), seal)
    expect(out).toEqual({ host: 'bastion', port: 22, user: 'deploy', auth: 'password', password: 'sealed:pw' })
  })

  test('a new password tunnel without a password is refused', () => {
    expect(() => mergeSshInput(undefined, input(), seal)).toThrow('Enter the SSH password.')
  })

  test('a new key tunnel needs the key text', () => {
    expect(() => mergeSshInput(undefined, input({ auth: 'key' }), seal)).toThrow('Paste a private key')
  })

  test('a new key tunnel stores the key and passphrase sealed', () => {
    const out = mergeSshInput(undefined, input({ auth: 'key', privateKey: KEY_TEXT, passphrase: 'phr' }), seal)
    expect(out?.privateKey).toBe(`sealed:${KEY_TEXT}`)
    expect(out?.passphrase).toBe('sealed:phr')
    expect(out?.password).toBeUndefined()
  })
})

describe('mergeSshInput: keeping secrets on update', () => {
  test('an empty password keeps the stored one when the login method stays the same', () => {
    const out = mergeSshInput(saved(), input({ password: '' }), seal)
    expect(out?.password).toBe('sealed:old')
  })

  test('clearPassword forgets the stored password, which then has to be entered again', () => {
    expect(() => mergeSshInput(saved(), input({ clearPassword: true }), seal)).toThrow('Enter the SSH password.')
  })

  test('a new password replaces the stored one', () => {
    expect(mergeSshInput(saved(), input({ password: 'fresh' }), seal)?.password).toBe('sealed:fresh')
  })

  test('switching from key to password needs a password', () => {
    const prev = saved({ auth: 'key', password: undefined, privateKey: 'sealed:key' })
    expect(() => mergeSshInput(prev, input({ auth: 'password' }), seal)).toThrow('Enter the SSH password.')
  })

  test('an empty key keeps the stored key and passphrase', () => {
    const prev = saved({ auth: 'key', password: undefined, privateKey: 'sealed:key', passphrase: 'sealed:phr' })
    const out = mergeSshInput(prev, input({ auth: 'key' }), seal)
    expect(out?.privateKey).toBe('sealed:key')
    expect(out?.passphrase).toBe('sealed:phr')
  })

  test('a new key replaces the stored key and drops the old passphrase', () => {
    const prev = saved({ auth: 'key', password: undefined, privateKey: 'sealed:key', passphrase: 'sealed:phr' })
    const out = mergeSshInput(prev, input({ auth: 'key', privateKey: KEY_TEXT }), seal)
    expect(out?.privateKey).toBe(`sealed:${KEY_TEXT}`)
    expect(out?.passphrase).toBeUndefined()
  })

  test('a new passphrase alone is kept with the stored key', () => {
    const prev = saved({ auth: 'key', password: undefined, privateKey: 'sealed:key' })
    const out = mergeSshInput(prev, input({ auth: 'key', passphrase: 'newphr' }), seal)
    expect(out?.privateKey).toBe('sealed:key')
    expect(out?.passphrase).toBe('sealed:newphr')
  })

  test('clearKey without a new key is refused', () => {
    const prev = saved({ auth: 'key', password: undefined, privateKey: 'sealed:key' })
    expect(() => mergeSshInput(prev, input({ auth: 'key', clearKey: true }), seal)).toThrow('Paste a private key')
  })
})

describe('mergeSshInput: the pinned host key', () => {
  test('kept while host and port stay the same', () => {
    const prev = saved({ hostKey: 'SHA256:pinned' })
    expect(mergeSshInput(prev, input({ password: 'x' }), seal)?.hostKey).toBe('SHA256:pinned')
  })

  test('dropped when the host changes, since it belongs to the other server', () => {
    const prev = saved({ hostKey: 'SHA256:pinned' })
    expect(mergeSshInput(prev, input({ host: 'other.example.com', password: 'x' }), seal)?.hostKey).toBeUndefined()
  })

  test('dropped when the port changes', () => {
    const prev = saved({ hostKey: 'SHA256:pinned' })
    expect(mergeSshInput(prev, input({ port: 2222, password: 'x' }), seal)?.hostKey).toBeUndefined()
  })
})

describe('sshInfo', () => {
  test('tells whether secrets exist, without their values', () => {
    const info = sshInfo(saved({ hostKey: 'SHA256:abc' }), {})
    expect(info).toEqual({
      host: 'bastion.example.com',
      port: 22,
      user: 'deploy',
      auth: 'password',
      hasPassword: true,
      hasKey: false,
      hostKey: 'SHA256:abc',
    })
    expect(JSON.stringify(info)).not.toContain('sealed')
  })

  test('a key tunnel reports hasKey, and an env or file reference counts as a key', () => {
    expect(sshInfo({ host: 'h', port: 22, user: 'u', auth: 'key', privateKey: 'x' }, {}).hasKey).toBe(true)
    const fromEnv = { host: 'h', port: 22, user: 'u', auth: 'key' as const, privateKeyEnv: 'KEY_VAR' }
    expect(sshInfo(fromEnv, { KEY_VAR: 'text' }).hasKey).toBe(true)
    expect(sshInfo(fromEnv, {}).hasKey).toBe(false)
    expect(sshInfo({ ...fromEnv, privateKeyEnv: undefined, privateKeyFile: '/run/keys/bastion' }, {}).hasKey).toBe(true)
  })

  test('a password from an env var is reported only when the variable is set', () => {
    const fromEnv = { host: 'h', port: 22, user: 'u', auth: 'password' as const, passwordEnv: 'SSH_PW' }
    expect(sshInfo(fromEnv, { SSH_PW: 'x' }).hasPassword).toBe(true)
    expect(sshInfo(fromEnv, {}).hasPassword).toBe(false)
  })

  test('never exposes the env var or file names', () => {
    const info = sshInfo({ host: 'h', port: 22, user: 'u', auth: 'key', privateKeyFile: '/run/keys/bastion' }, {})
    expect(JSON.stringify(info)).not.toContain('/run/keys')
  })
})
