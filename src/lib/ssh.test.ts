import { describe, expect, test } from 'bun:test'
import { looksLikePrivateKey, shortenMiddle, SSH_KEY_MESSAGE } from './ssh'
import { sshInputOptional, sshInputSchema } from './ssh-input.server'

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'

describe('sshInputSchema', () => {
  test('a password tunnel needs host, user and auth; the port defaults to 22', () => {
    const parsed = sshInputSchema.parse({ host: ' bastion ', user: 'deploy', auth: 'password' })
    expect(parsed).toMatchObject({ host: 'bastion', port: 22, user: 'deploy', auth: 'password' })
  })

  test('host and user are required', () => {
    expect(sshInputSchema.safeParse({ host: '', user: 'u', auth: 'password' }).success).toBe(false)
    expect(sshInputSchema.safeParse({ host: 'h', user: '  ', auth: 'password' }).success).toBe(false)
  })

  test('the port must be 1 to 65535', () => {
    expect(sshInputSchema.safeParse({ host: 'h', user: 'u', auth: 'key', port: 0 }).success).toBe(false)
    expect(sshInputSchema.safeParse({ host: 'h', user: 'u', auth: 'key', port: 65536 }).success).toBe(false)
  })

  test('the login method must be password or key', () => {
    expect(sshInputSchema.safeParse({ host: 'h', user: 'u', auth: 'agent' }).success).toBe(false)
  })

  test('a private key must contain PRIVATE KEY', () => {
    const bad = sshInputSchema.safeParse({ host: 'h', user: 'u', auth: 'key', privateKey: 'ssh-rsa AAAA' })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.message).toBe(SSH_KEY_MESSAGE)
    expect(sshInputSchema.safeParse({ host: 'h', user: 'u', auth: 'key', privateKey: KEY }).success).toBe(true)
  })

  test('null and undefined are accepted by the optional form (remove or keep the tunnel)', () => {
    expect(sshInputOptional.parse(null)).toBeNull()
    expect(sshInputOptional.parse(undefined)).toBeUndefined()
  })
})

describe('looksLikePrivateKey', () => {
  test('recognises PEM and OpenSSH key text', () => {
    expect(looksLikePrivateKey('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(looksLikePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(looksLikePrivateKey('ssh-ed25519 AAAA user@host')).toBe(false)
  })
})

describe('shortenMiddle', () => {
  test('keeps short text as it is', () => {
    expect(shortenMiddle('SHA256:abc')).toBe('SHA256:abc')
  })

  test('cuts the middle of a long fingerprint', () => {
    expect(shortenMiddle('SHA256:abcdefghijklmnopqrstuvwxyz0123456789', 6)).toBe('SHA256…456789')
  })
})
