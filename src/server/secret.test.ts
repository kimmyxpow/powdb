import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decryptSecret, deriveKeyFromSecret, encryptSecret, isEncrypted } from './secret.server'

const SAVED = { dir: process.env.POWVIEW_DATA_DIR, secret: process.env.POWVIEW_SECRET }
const TAMPERED =
  'This saved password cannot be decrypted. If POWVIEW_SECRET changed, set it back or enter the password again.'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'powview-secret-'))
  process.env.POWVIEW_DATA_DIR = dir
  delete process.env.POWVIEW_SECRET
})

afterEach(() => {
  if (SAVED.dir === undefined) delete process.env.POWVIEW_DATA_DIR
  else process.env.POWVIEW_DATA_DIR = SAVED.dir
  if (SAVED.secret === undefined) delete process.env.POWVIEW_SECRET
  else process.env.POWVIEW_SECRET = SAVED.secret
  rmSync(dir, { recursive: true, force: true })
})

function fileKey(): Buffer {
  return Buffer.from(readFileSync(path.join(dir, 'encryption.key'), 'utf8').trim(), 'base64')
}

describe('saved password encryption', () => {
  test('round trip: the stored form is enc:v1:<iv>:<ciphertext> and never contains the password', () => {
    const stored = encryptSecret('s3cret pässword')
    expect(stored).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    expect(stored).not.toContain('s3cret')
    expect(isEncrypted(stored)).toBe(true)
    expect(decryptSecret(stored)).toBe('s3cret pässword')
    // a fresh IV every time
    expect(encryptSecret('s3cret pässword')).not.toBe(stored)
  })

  test('a value without the enc:v1: prefix is refused with the save-again message', () => {
    expect(isEncrypted('plain-password')).toBe(false)
    expect(() => decryptSecret('plain-password')).toThrow('A stored secret is not encrypted. Save it again.')
    expect(() => decryptSecret('enc:v2:whatever')).toThrow('A stored secret is not encrypted. Save it again.')
    expect(isEncrypted(undefined)).toBe(false)
  })

  test('tampered ciphertext fails with the clear message', () => {
    const parts = encryptSecret('hunter2').split(':')
    const body = parts[3]!
    parts[3] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1)
    expect(() => decryptSecret(parts.join(':'))).toThrow(TAMPERED)
    expect(() => decryptSecret('enc:v1:bm90LWEtaXY=:Zm9v')).toThrow(TAMPERED)
  })

  test('the key file is random, mode 0600, and created once', () => {
    const stored = encryptSecret('one')
    const file = path.join(dir, 'encryption.key')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const key = readFileSync(file, 'utf8')
    expect(fileKey()).toHaveLength(32)
    expect(decryptSecret(stored)).toBe('one')
    encryptSecret('two')
    expect(readFileSync(file, 'utf8')).toBe(key)
    expect(readdirSync(dir).sort()).toEqual(['encryption.key'])
  })

  test('the POWVIEW_SECRET key differs from the file key and is needed to read its values', () => {
    const secret = 'a long enough secret'
    encryptSecret('warm up file key')
    expect(deriveKeyFromSecret(secret).equals(fileKey())).toBe(false)

    process.env.POWVIEW_SECRET = secret
    const stored = encryptSecret('kept outside the volume')
    expect(decryptSecret(stored)).toBe('kept outside the volume')

    delete process.env.POWVIEW_SECRET
    expect(() => decryptSecret(stored)).toThrow(TAMPERED)
  })

  test('a POWVIEW_SECRET shorter than 16 characters refuses to encrypt', () => {
    process.env.POWVIEW_SECRET = 'too-short'
    expect(() => encryptSecret('pw')).toThrow('at least 16 characters')
  })
})
