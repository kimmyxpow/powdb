import net from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import type { ConnectionConfig, SshSettings } from '@/lib/types'
import { decryptSecret } from './secret.server'
import { rememberHostKey } from './store.server'
import { formatHostKeyFingerprint, tunnelKey, type ResolvedSsh } from './ssh-settings'

/**
 * SSH tunnels. pow/view opens an SSH connection to a bastion and forwards a local port to
 * PostgreSQL through it: pg connects to 127.0.0.1:<port>, the bastion connects to the database.
 * One tunnel per connection. Settings are compared with a fingerprint, so a change starts a new one.
 */

const KEEPALIVE_MS = 15_000
const READY_TIMEOUT_MS = 15_000

export interface TunnelEndpoint {
  host: '127.0.0.1'
  port: number
}

interface Tunnel {
  name: string
  ssh: ResolvedSsh
  dbHost: string
  dbPort: number
  /** saved, non-managed connections remember their host key on first use */
  connectionId?: string
  server: net.Server
  port: number
  sockets: Set<net.Socket>
  client: Client | null
  connecting: Promise<Client> | null
  closed: boolean
  /** set when the host key check refuses the server */
  hostKeyError?: string
  /** the host key seen on this connection (SHA256:...) */
  observedHostKey?: string
}

interface Slot {
  key: string
  ready: Promise<Tunnel>
}

const globalTunnels = globalThis as unknown as { __powviewTunnels?: Map<string, Slot> }
const slots = (globalTunnels.__powviewTunnels ??= new Map())

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function fromEnv(name: string, what: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`The SSH ${what} is not set. Set the environment variable ${name}.`)
  return value
}

async function keyFromFile(file: string): Promise<string> {
  try {
    return await Bun.file(file).text()
  } catch (err) {
    throw new Error(`Could not read the SSH private key file ${file}: ${(err as Error).message}`)
  }
}

/** Reads environment variables and files, and decrypts stored secrets. Used right before connecting. */
async function resolveSsh(ssh: SshSettings): Promise<ResolvedSsh> {
  const base = { host: ssh.host, port: ssh.port, user: ssh.user, auth: ssh.auth, hostKey: ssh.hostKey }
  if (ssh.auth === 'password') {
    const password = ssh.passwordEnv
      ? fromEnv(ssh.passwordEnv, 'password')
      : ssh.password
        ? decryptSecret(ssh.password)
        : undefined
    if (!password) throw new Error('The SSH password is missing. Enter it in the connection settings.')
    return { ...base, password }
  }
  const privateKey = ssh.privateKeyFile
    ? await keyFromFile(ssh.privateKeyFile)
    : ssh.privateKeyEnv
      ? fromEnv(ssh.privateKeyEnv, 'private key')
      : ssh.privateKey
        ? decryptSecret(ssh.privateKey)
        : undefined
  if (!privateKey) throw new Error('The SSH private key is missing. Add it in the connection settings.')
  const passphrase = ssh.passphraseEnv
    ? process.env[ssh.passphraseEnv] || undefined
    : ssh.passphrase
      ? decryptSecret(ssh.passphrase)
      : undefined
  return { ...base, privateKey, passphrase }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function forwardMessage(dbHost: string, dbPort: number): string {
  return `The SSH server could not reach ${dbHost}:${dbPort}. The database host and port are resolved on the SSH server (often localhost:5432).`
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'])

/** Turns an ssh2 error into a message a person can act on. */
function sshMessage(err: Error & { level?: string; code?: string }, ssh: ResolvedSsh): string {
  if (err.level === 'client-authentication') {
    return `SSH login failed for ${ssh.user}@${ssh.host}. Check the user, password or key.`
  }
  const network =
    err.level === 'client-socket' ||
    err.level === 'client-timeout' ||
    (err.code !== undefined && NETWORK_CODES.has(err.code))
  if (network) {
    const reason = err.code ?? err.message
    return `Could not reach the SSH server ${ssh.host}:${ssh.port}: ${reason}`
  }
  return `SSH connection to ${ssh.host}:${ssh.port} failed: ${err.message}`
}

// ---------------------------------------------------------------------------
// SSH client
// ---------------------------------------------------------------------------

/** Opens the SSH connection (or joins the one in progress). Resolves once authenticated. */
function connectSsh(t: Tunnel): Promise<Client> {
  if (t.closed) return Promise.reject(new Error('The SSH tunnel was closed.'))
  if (t.connecting) return t.connecting
  const ssh = t.ssh
  const connecting = new Promise<Client>((resolve, reject) => {
    const client = new Client()
    let settled = false
    let pendingHostKey: string | undefined

    const config: ConnectConfig = {
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_MS,
      tryKeyboard: false,
      hostHash: 'sha256',
      // hostHash is 'sha256': ssh2 passes the hex digest of the host key. The check is synchronous.
      hostVerifier: (hex: string): boolean => {
        const seen = formatHostKeyFingerprint(hex)
        t.observedHostKey = seen
        if (ssh.hostKey && ssh.hostKey !== seen) {
          t.hostKeyError = `The SSH server's host key changed (expected ${ssh.hostKey}, got ${seen}). If this is expected, remove and add the SSH settings again.`
          return false
        }
        if (!ssh.hostKey) pendingHostKey = seen
        return true
      },
    }
    if (ssh.auth === 'password') config.password = ssh.password
    else {
      config.privateKey = ssh.privateKey
      config.passphrase = ssh.passphrase
    }

    client.once('ready', () => {
      if (settled) return
      settled = true
      // The tunnel was closed while the handshake was running: do not keep this connection.
      if (t.closed) {
        client.end()
        reject(new Error('The SSH tunnel was closed.'))
        return
      }
      t.client = client
      if (pendingHostKey && !ssh.hostKey) {
        ssh.hostKey = pendingHostKey
        if (t.connectionId) {
          rememberHostKey(t.connectionId, pendingHostKey).catch((err: Error) =>
            console.warn(`[powview] could not remember the SSH host key for ${t.name}: ${err.message}`),
          )
        }
      }
      resolve(client)
    })

    client.on('error', (err: Error & { level?: string; code?: string }) => {
      if (!settled) {
        settled = true
        client.destroy()
        reject(new Error(t.hostKeyError ?? sshMessage(err, ssh)))
        return
      }
      lost(t, client, err.message)
    })
    client.on('close', () => {
      if (!settled) {
        settled = true
        reject(new Error(t.hostKeyError ?? 'The SSH server closed the connection.'))
        return
      }
      lost(t, client, 'connection ended')
    })

    client.connect(config)
  })
  t.connecting = connecting
  const clear = () => {
    if (t.connecting === connecting) t.connecting = null
  }
  connecting.then(clear, clear)
  return connecting
}

/** The SSH connection dropped: forget it (the next use reconnects) and cut the local sockets. */
function lost(t: Tunnel, client: Client, reason: string) {
  if (t.client !== client) return
  t.client = null
  if (!t.closed) console.warn(`[powview] ssh tunnel for ${t.name} closed: ${reason}`)
  for (const socket of t.sockets) socket.destroy()
  t.sockets.clear()
}

function liveClient(t: Tunnel): Promise<Client> {
  if (t.client) return Promise.resolve(t.client)
  return connectSsh(t)
}

function probeForward(client: Client, dbHost: string, dbPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, dbHost, dbPort, (err, stream) => {
      if (err) {
        reject(new Error(forwardMessage(dbHost, dbPort)))
        return
      }
      stream.end()
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Local forwarding server
// ---------------------------------------------------------------------------

function handleSocket(t: Tunnel, sock: net.Socket) {
  t.sockets.add(sock)
  sock.on('close', () => t.sockets.delete(sock))
  sock.on('error', () => sock.destroy())
  liveClient(t)
    .then((client) => {
      client.forwardOut('127.0.0.1', sock.remotePort ?? 0, t.dbHost, t.dbPort, (err, stream) => {
        if (err) {
          console.warn(`[powview] ${forwardMessage(t.dbHost, t.dbPort)} (${t.name})`)
          sock.destroy()
          return
        }
        stream.on('error', () => sock.destroy())
        stream.on('close', () => sock.destroy())
        // pipe() does not end the channel when the local socket is destroyed, so close it here.
        sock.on('close', () => stream.destroy())
        sock.pipe(stream).pipe(sock)
      })
    })
    .catch((err: Error) => {
      console.warn(`[powview] ssh tunnel for ${t.name}: ${err.message}`)
      sock.destroy()
    })
}

interface StartOptions {
  name: string
  ssh: ResolvedSsh
  dbHost: string
  dbPort: number
  connectionId?: string
  /** open a channel to the database now, so a wrong host or port fails here with a clear message */
  probe?: boolean
}

async function startTunnel(opts: StartOptions): Promise<Tunnel> {
  const t: Tunnel = {
    name: opts.name,
    ssh: { ...opts.ssh },
    dbHost: opts.dbHost,
    dbPort: opts.dbPort,
    connectionId: opts.connectionId,
    server: net.createServer(),
    port: 0,
    sockets: new Set(),
    client: null,
    connecting: null,
    closed: false,
  }
  t.server.on('connection', (sock) => handleSocket(t, sock))
  await new Promise<void>((resolve, reject) => {
    t.server.once('error', reject)
    t.server.listen(0, '127.0.0.1', () => {
      t.server.off('error', reject)
      resolve()
    })
  })
  t.port = (t.server.address() as net.AddressInfo).port
  try {
    const client = await connectSsh(t)
    if (opts.probe) await probeForward(client, opts.dbHost, opts.dbPort)
  } catch (err) {
    closeEntry(t)
    throw err
  }
  return t
}

function closeEntry(t: Tunnel) {
  t.closed = true
  t.server.close()
  for (const socket of t.sockets) socket.destroy()
  t.sockets.clear()
  const client = t.client
  t.client = null
  client?.end()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The local endpoint to connect pg to for a saved connection with an SSH tunnel. The tunnel is
 * started once; concurrent callers share the start. Settings changes start a new tunnel.
 */
export async function ensureTunnel(conn: ConnectionConfig): Promise<TunnelEndpoint> {
  if (!conn.ssh) throw new Error('This connection does not use an SSH tunnel.')
  const resolved = await resolveSsh(conn.ssh)
  const key = tunnelKey(resolved, conn.host, conn.port)
  let slot = slots.get(conn.id)
  if (!slot || slot.key !== key) {
    const previous = slot
    const next = { key } as Slot
    next.ready = startTunnel({
      name: conn.name,
      ssh: resolved,
      dbHost: conn.host,
      dbPort: conn.port,
      // managed connections come from powview.yaml and are never changed by pow/view
      connectionId: conn.managed ? undefined : conn.id,
      // check the database is reachable from the SSH server once, so a wrong host or port
      // gives a clear message instead of pg's "Connection terminated unexpectedly"
      probe: true,
    }).catch((err: unknown) => {
      if (slots.get(conn.id) === next) slots.delete(conn.id)
      throw err
    })
    slots.set(conn.id, next)
    slot = next
    if (previous)
      void previous.ready.then(
        (t: Tunnel) => closeEntry(t),
        () => {},
      )
  }
  const t = await slot.ready
  await liveClient(t)
  return { host: '127.0.0.1', port: t.port }
}

/** Stops the tunnel of a connection (its settings changed, or the connection was removed). */
export async function closeTunnel(connectionId: string): Promise<void> {
  const slot = slots.get(connectionId)
  if (!slot) return
  slots.delete(connectionId)
  // Not awaited: a tunnel that is still connecting closes when it is ready, and a save does not wait for it.
  void slot.ready.then(
    (t: Tunnel) => closeEntry(t),
    () => {},
  )
}

/**
 * A temporary tunnel for "Test connection" before saving. Checks that the database is reachable
 * from the SSH server, and returns the host key so the user can see it. Closes with close().
 */
export async function testTunnel(
  ssh: SshSettings,
  dbHost: string,
  dbPort: number,
  name: string,
): Promise<{ endpoint: TunnelEndpoint; hostKey: string; close: () => void }> {
  const resolved = await resolveSsh(ssh)
  const t = await startTunnel({ name, ssh: resolved, dbHost, dbPort, probe: true })
  const hostKey = t.observedHostKey ?? ssh.hostKey ?? ''
  return {
    endpoint: { host: '127.0.0.1', port: t.port },
    hostKey,
    close: () => closeEntry(t),
  }
}
