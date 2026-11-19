import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { ISOLATED, runInChildProcess } from './http/test-process'

// Stateful (auth.json is cached in the auth module): runs in a child process.
if (!ISOLATED) {
  test('API token expiry passes in an isolated process', () => runInChildProcess(import.meta.path), 120_000)
} else {
  const DAY = 86_400_000
  const dir = process.env.POWDBS_DATA_DIR!
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const neverToken = 'powdbs_neverNeverneverNeverneverNever12'
  const expiredToken = 'powdbs_expiredExpiredExpiredExpiredEx12'
  const past = new Date(Date.now() - 2 * DAY).toISOString()
  const base = { prefix: 'powdbs_', scope: 'read', connections: 'all', createdAt: past }

  // auth.json with a token that never expires (expiresAt null) and one that has already expired.
  writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      version: 1,
      admin: null,
      secret: randomBytes(32).toString('base64'),
      localKey: randomBytes(32).toString('base64url'),
      tokens: [
        {
          ...base,
          id: 'never01',
          name: 'never token',
          prefix: neverToken.slice(0, 12),
          expiresAt: null,
          hash: sha(neverToken),
        },
        {
          ...base,
          id: 'expired1',
          name: 'expired token',
          prefix: expiredToken.slice(0, 12),
          expiresAt: past,
          hash: sha(expiredToken),
        },
      ],
    }),
  )

  const auth = await import('@/server/auth.server')

  describe('token expiry', () => {
    test('a new token expires in 90 days by default', async () => {
      const created = await auth.createApiToken({ name: 'default' })
      const days = (Date.parse(created.info.expiresAt!) - Date.now()) / DAY
      expect(days).toBeGreaterThan(89.99)
      expect(days).toBeLessThan(90.01)
      expect(await auth.verifyApiToken(created.token)).not.toBeNull()
    })

    test('explicit days are honoured and must be a positive whole number', async () => {
      const created = await auth.createApiToken({ name: 'thirty', expiresInDays: 30 })
      const days = (Date.parse(created.info.expiresAt!) - Date.now()) / DAY
      expect(Math.round(days)).toBe(30)
      await expect(auth.createApiToken({ name: 'bad', expiresInDays: 0 })).rejects.toThrow('whole number of days')
      await expect(auth.createApiToken({ name: 'bad', expiresInDays: 1.5 })).rejects.toThrow('whole number of days')
    })

    test('null means the token never expires', async () => {
      const created = await auth.createApiToken({ name: 'forever', expiresInDays: null })
      expect(created.info.expiresAt).toBeNull()
      expect(await auth.verifyApiToken(created.token)).not.toBeNull()
    })

    test('an expired token fails verification but is still listed until revoked', async () => {
      expect(await auth.verifyApiToken(expiredToken)).toBeNull()
      const listed = await auth.listApiTokens()
      const entry = listed.find((t) => t.id === 'expired1')
      expect(entry?.expiresAt).toBe(past)
      expect(JSON.stringify(entry)).not.toContain('hash')
      await auth.revokeApiToken('expired1')
      expect((await auth.listApiTokens()).some((t) => t.id === 'expired1')).toBe(false)
    })

    test('a token with expiresAt null never expires', async () => {
      const info = await auth.verifyApiToken(neverToken)
      expect(info?.name).toBe('never token')
      expect(info?.expiresAt).toBeNull()
      const listed = await auth.listApiTokens()
      expect(listed.find((t) => t.id === 'never01')?.expiresAt).toBeNull()
    })
  })
}
