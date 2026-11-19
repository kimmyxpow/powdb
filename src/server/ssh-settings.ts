// Pure SSH tunnel helpers: no sockets, no files, no store.
import type { SshAuth, SshInfo, SshInput, SshSettings } from '@/lib/types'

/** What a tunnel connects with, after environment variables and files are read and secrets decrypted. */
export interface ResolvedSsh {
  host: string
  port: number
  user: string
  auth: SshAuth
  password?: string
  privateKey?: string
  passphrase?: string
  hostKey?: string
}

/**
 * OpenSSH style host key fingerprint: "SHA256:" followed by the base64 digest without padding.
 * Takes the hex digest that ssh2 passes to hostVerifier when hostHash is 'sha256'.
 */
export function formatHostKeyFingerprint(hexDigest: string): string {
  return `SHA256:${Buffer.from(hexDigest, 'hex').toString('base64').replace(/=+$/, '')}`
}

/**
 * Identifies one tunnel: the SSH settings with their secrets, and the database it reaches.
 * The pinned host key is left out on purpose: remembering it must not restart the tunnel.
 */
export function tunnelKey(ssh: ResolvedSsh, dbHost: string, dbPort: number): string {
  const { hostKey: _pinned, ...settings } = ssh
  return new Bun.CryptoHasher('sha256').update(JSON.stringify([settings, dbHost, dbPort])).digest('hex')
}

/**
 * The SSH settings as saved, merged with what the user sent. Rules:
 * - undefined input: keep the tunnel as it is
 * - null input: remove the tunnel
 * - an empty secret keeps the stored one (when the login method is the same)
 * - a new private key replaces the stored one and its passphrase
 * - the pinned host key is kept only while host and port stay the same
 * `seal` encrypts a new secret (encryptSecret when saving, identity when testing a draft).
 */
export function mergeSshInput(
  prev: SshSettings | undefined,
  input: SshInput | null | undefined,
  seal: (plain: string) => string,
): SshSettings | undefined {
  if (input === undefined) return prev
  if (input === null) return undefined
  const host = input.host.trim()
  const sameServer = prev !== undefined && prev.host === host && prev.port === input.port
  const sameMethod = prev !== undefined && prev.auth === input.auth
  const base: SshSettings = { host, port: input.port, user: input.user.trim(), auth: input.auth }
  if (sameServer && prev?.hostKey) base.hostKey = prev.hostKey

  if (input.auth === 'password') {
    const password = input.password
      ? seal(input.password)
      : sameMethod && !input.clearPassword
        ? prev?.password
        : undefined
    if (!password) throw new Error('Enter the SSH password.')
    return { ...base, password }
  }

  const keepKey = sameMethod && !input.clearKey
  const keyReplaced = Boolean(input.privateKey)
  const privateKey = keyReplaced ? seal(input.privateKey!) : keepKey ? prev?.privateKey : undefined
  if (!privateKey) throw new Error('Paste a private key, or load it from a file.')
  let passphrase: string | undefined
  if (input.passphrase) passphrase = seal(input.passphrase)
  else if (!keyReplaced && keepKey) passphrase = prev?.passphrase
  const out: SshSettings = { ...base, privateKey }
  if (passphrase) out.passphrase = passphrase
  return out
}

/** The safe view for clients: whether secrets exist, never their values or env var / file names. */
export function sshInfo(ssh: SshSettings, env: NodeJS.ProcessEnv = process.env): SshInfo {
  const hasPassword = ssh.auth === 'password' && Boolean(ssh.passwordEnv ? env[ssh.passwordEnv] : ssh.password)
  const hasKey =
    ssh.auth === 'key' && Boolean(ssh.privateKey || (ssh.privateKeyEnv && env[ssh.privateKeyEnv]) || ssh.privateKeyFile)
  const info: SshInfo = {
    host: ssh.host,
    port: ssh.port,
    user: ssh.user,
    auth: ssh.auth,
    hasPassword,
    hasKey,
  }
  if (ssh.hostKey) info.hostKey = ssh.hostKey
  return info
}
