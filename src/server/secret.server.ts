import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from './store.server'

/**
 * Encryption for saved connection passwords (AES-256-GCM). The key comes from POWVIEW_SECRET
 * when it is set, otherwise from encryption.key in the data folder (created on first use).
 *
 * Stored form: enc:v1:<base64 iv, 12 bytes>:<base64 ciphertext followed by the 16-byte tag>
 */

const PREFIX = 'enc:v1:'
const KEY_FILE = 'encryption.key'
const KEY_DOMAIN = 'powview:connection-passwords:v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const MIN_SECRET_LENGTH = 16

const UNREADABLE =
  'This saved password cannot be decrypted. If POWVIEW_SECRET changed, set it back or enter the password again.'

export function isEncrypted(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** The key derived from POWVIEW_SECRET: SHA-256 over a fixed domain string and the secret. */
export function deriveKeyFromSecret(secret: string): Buffer {
  return Buffer.from(new Bun.CryptoHasher('sha256').update(KEY_DOMAIN).update('\0').update(secret).digest())
}

function keyFile(): string {
  return path.join(dataDir(), KEY_FILE)
}

/** The random key in encryption.key. Created (atomically, mode 0600) only when asked to. */
function fileKey(create: boolean): Buffer | null {
  const file = keyFile()
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
    if (key.length !== 32) {
      throw new Error(`The encryption key in ${file} is damaged. Restore it from a backup, or set POWVIEW_SECRET.`)
    }
    return key
  }
  if (!create) return null
  const key = randomBytes(32)
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, key.toString('base64'), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return key
}

/** The active key, or null when there is none and `create` is false. */
function activeKey(create: boolean): Buffer | null {
  const secret = process.env.POWVIEW_SECRET
  if (secret) {
    if (secret.length < MIN_SECRET_LENGTH) {
      const message = `POWVIEW_SECRET must be at least ${MIN_SECRET_LENGTH} characters. Passwords cannot be encrypted until it is.`
      console.warn(`[powview] ${message}`)
      throw new Error(message)
    }
    return deriveKeyFromSecret(secret)
  }
  return fileKey(create)
}

/** Encrypts a password for storage. Throws when no usable key is available. */
export function encryptSecret(plain: string): string {
  const key = activeKey(true)
  if (!key) throw new Error('No encryption key is available.')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${PREFIX}${iv.toString('base64')}:${body.toString('base64')}`
}

/**
 * The plain password. A value without the enc:v1: prefix is refused: every stored password is
 * encrypted, so one that is not has to be entered again.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) throw new Error('A stored secret is not encrypted. Save it again.')
  const parts = stored.slice(PREFIX.length).split(':')
  const key = activeKey(false)
  if (!key || parts.length !== 2) throw new Error(UNREADABLE)
  const iv = Buffer.from(parts[0]!, 'base64')
  const body = Buffer.from(parts[1]!, 'base64')
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error(UNREADABLE)
  const data = body.subarray(0, body.length - TAG_BYTES)
  const tag = body.subarray(body.length - TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(UNREADABLE)
  }
}
