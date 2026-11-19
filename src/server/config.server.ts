import path from 'node:path'
import { parseConnectionUrl } from '@/lib/connection-url'
import { redactSecrets } from '@/lib/redact'
import { s, type Infer } from '@/lib/schema'
import { CONNECTION_COLORS } from '@/lib/types'
import type { ConnectionConfig, SshSettings } from '@/lib/types'

/**
 * Declarative connections from powdbs.yaml. They are "managed": the file is the source of
 * truth, so the UI, API and CLI cannot edit or delete them. Only the file's own loader
 * (store.server.ts, on start) changes them.
 */
export type ManagedConnection = Omit<ConnectionConfig, 'createdAt' | 'lastUsedAt'> & {
  managed: true
}

const ID_PATTERN = /^[a-z0-9_-]{1,40}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const envName = s.string().regex(ENV_NAME_PATTERN, 'must be an environment variable name')

/**
 * Optional SSH tunnel. Exactly one way to log in: password_env, private_key_file (a path
 * inside the container, e.g. a read-only volume) or private_key_env. Secrets are never in the file.
 */
const sshSchema = s
  .strictObject({
    host: s.string().trim().min(1, 'host is required').max(255),
    port: s.number().int().min(1).max(65535).default(22),
    user: s.string().trim().min(1, 'user is required').max(255),
    password_env: envName.optional(),
    private_key_file: s.string().trim().min(1).optional(),
    private_key_env: envName.optional(),
    passphrase_env: envName.optional(),
    host_key: s
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]+$/, 'host_key must look like SHA256:... (the fingerprint PowDBs shows)')
      .optional(),
  })
  .superRefine((ssh, ctx) => {
    const logins = [ssh.password_env, ssh.private_key_file, ssh.private_key_env].filter((v) => v !== undefined)
    if (logins.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'give exactly one of password_env, private_key_file or private_key_env',
      })
    }
    if (ssh.passphrase_env && ssh.password_env) {
      ctx.addIssue({ code: 'custom', message: 'passphrase_env only applies to a private key' })
    }
  })

const entrySchema = s.strictObject({
  id: s.string().regex(ID_PATTERN, 'id must be 1-40 characters: a-z, 0-9, "_" or "-"'),
  name: s.string().trim().max(120).optional(),
  url: s.string().refine((v) => parseConnectionUrl(v) !== null, 'url must start with postgres:// or postgresql://'),
  password_env: s.string().regex(ENV_NAME_PATTERN, 'password_env must be an environment variable name').optional(),
  read_only: s.boolean().default(false),
  production: s.boolean().default(false),
  ai_access: s.enum(['off', 'read', 'write']).default('read'),
  color: s.enum(CONNECTION_COLORS).default('neutral'),
  ssh: sshSchema.optional(),
})

/** The managed form of an ssh block: references only, read when connecting. */
function managedSsh(ssh: Infer<typeof sshSchema>): SshSettings {
  const out: SshSettings = {
    host: ssh.host,
    port: ssh.port,
    user: ssh.user,
    auth: ssh.password_env ? 'password' : 'key',
  }
  if (ssh.password_env) out.passwordEnv = ssh.password_env
  if (ssh.private_key_file) out.privateKeyFile = ssh.private_key_file
  if (ssh.private_key_env) out.privateKeyEnv = ssh.private_key_env
  if (ssh.passphrase_env) out.passphraseEnv = ssh.passphrase_env
  if (ssh.host_key) out.hostKey = ssh.host_key
  return out
}

const fileSchema = s.object({
  connections: s.array(entrySchema).default([]),
})

/** Where the declarative file lives: $POWDBS_CONFIG, else <data dir>/powdbs.yaml. */
function configPath(dataDirPath: string): string {
  return process.env.POWDBS_CONFIG ? path.resolve(process.env.POWDBS_CONFIG) : path.join(dataDirPath, 'powdbs.yaml')
}

/** Parse and validate the file text. Throws with every problem in the message. */
export function parseConfigText(text: string, file: string): ManagedConnection[] {
  const raw = file.endsWith('.json') ? JSON.parse(text) : Bun.YAML.parse(text)
  const parsed = fileSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
  }
  const seen = new Set<string>()
  for (const c of parsed.data.connections) {
    if (seen.has(c.id)) throw new Error(`duplicate connection id "${c.id}"`)
    seen.add(c.id)
  }
  return parsed.data.connections.map((c) => {
    const url = parseConnectionUrl(c.url)!
    const managed: ManagedConnection = {
      id: c.id,
      name: c.name || `${url.database} @ ${url.host}`,
      color: c.color,
      host: url.host,
      port: url.port,
      database: url.database,
      user: url.user,
      password: url.password || undefined,
      passwordEnv: c.password_env,
      ssl: url.ssl,
      readOnly: c.read_only,
      production: c.production,
      aiAccess: c.ai_access,
      managed: true,
    }
    if (c.ssh) managed.ssh = managedSsh(c.ssh)
    return managed
  })
}

/**
 * Read powdbs.yaml. A missing file means no managed connections ([]). An invalid file is
 * logged and ignored (null), so the caller keeps what it already has and PowDBs still starts.
 */
export async function loadManagedConnections(dataDirPath: string): Promise<ManagedConnection[] | null> {
  const file = configPath(dataDirPath)
  let text: string
  try {
    text = await Bun.file(file).text()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn(`[powdbs] cannot read ${file}, ignoring it: ${redactSecrets((err as Error).message)}`)
    return null
  }
  try {
    return parseConfigText(text, file)
  } catch (err) {
    // A YAML or JSON syntax error can quote the line it failed on, which may hold a URL password.
    console.warn(`[powdbs] ignoring invalid ${file}: ${redactSecrets((err as Error).message)}`)
    return null
  }
}
