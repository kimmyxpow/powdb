import { redactSecrets } from '@/lib/redact'
import type { ConnectionConfig, SslMode } from '@/lib/types'
import {
  EXPORT_CONTENTS,
  EXPORT_FORMATS,
  PG_DUMP_MISSING_MESSAGE,
  exportExtension,
  type DatabaseExportRequest,
  type ExportContent,
  type ExportFormat,
  type PgDumpStatus,
} from '@/lib/db-export'
import { authenticate } from './access.server'
import { SESSION_COOKIE } from './auth.server'
import { pgTarget } from './pg-target.server'
import { listConnections } from './store.server'
import { HttpError, badRequest, errorToResponse, guardOrigin, jsonResponse, readCookie } from './http/util.server'

/**
 * Database export: runs pg_dump and streams its output to the browser. The route is a
 * thin wrapper; everything else lives here. Arguments are always an array (never a shell
 * string) and the password only ever travels in PGPASSWORD.
 */

const MAX_LIST_ITEMS = 1000
const MAX_NAME_LENGTH = 255

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** Where pg_dump connects. The password is kept apart from everything that reaches the argument list. */
export interface DumpTarget {
  host: string
  port: number
  user: string
  database: string
  ssl: SslMode
  password?: string
  /** set through an SSH tunnel: `host` is then the local address and this the real host (TLS name) */
  tlsHost?: string
}

interface DumpPlan {
  args: string[]
  env: Record<string, string>
}

/** A pg_dump pattern for one name: double quoted, so case, dots and wildcards stay literal. */
export function quotePgName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** One libpq keyword value, single quoted with backslash escapes. */
function libpqValue(value: string): string {
  return `'${value.replace(/[\\']/g, (ch) => `\\${ch}`)}'`
}

/**
 * The libpq connection string for a target: host, port, user and database, each single quoted.
 * The password is not part of it (it travels in PGPASSWORD). Through a tunnel, libpq connects to
 * hostaddr (the local end) and checks the certificate against host.
 */
export function conninfo(target: Pick<DumpTarget, 'host' | 'port' | 'user' | 'database' | 'tlsHost'>): string {
  const hostParts = target.tlsHost
    ? [`host=${libpqValue(target.tlsHost)}`, `hostaddr=${libpqValue(target.host)}`]
    : [`host=${libpqValue(target.host)}`]
  return [
    ...hostParts,
    `port=${libpqValue(String(target.port))}`,
    `user=${libpqValue(target.user)}`,
    `dbname=${libpqValue(target.database)}`,
  ].join(' ')
}

/** PATH for the child processes, which get nothing else from the server's environment. */
function childPath(): string {
  return process.env.PATH ?? '/usr/bin:/bin'
}

/** libpq and PostgreSQL client settings for a child process. The password is only ever in PGPASSWORD. */
export function pgClientEnv(target: DumpTarget): Record<string, string> {
  const env: Record<string, string> = {
    PATH: childPath(),
    PGSSLMODE: target.ssl,
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'powview',
  }
  if (target.password) env.PGPASSWORD = target.password
  return env
}

/**
 * The pg_dump arguments and environment for one export. Pure: no process is started.
 * Content: `schema` dumps structure only, `data` dumps data only, `all` both.
 */
export function buildDumpPlan(
  pgDump: string,
  target: DumpTarget,
  req: Pick<DatabaseExportRequest, 'content' | 'format' | 'schemas' | 'tables'>,
): DumpPlan {
  if (req.schemas?.length && req.tables?.length) {
    throw new Error('Choose schemas or tables, not both.')
  }
  const args = [
    pgDump,
    `--dbname=${conninfo(target)}`,
    '--no-password', // never prompt: a missing password fails instead of hanging
    '--no-owner',
    '--no-privileges',
    req.format === 'custom' ? '--format=custom' : '--format=plain',
  ]
  // pg_dump gzips the plain output itself at level 6 (an integer --compress means gzip in pg_dump 14 through 18).
  if (req.format === 'sql-gz') args.push('--compress=6')
  if (req.content === 'schema') args.push('--schema-only')
  if (req.content === 'data') args.push('--data-only')
  for (const schema of req.schemas ?? []) args.push(`--schema=${quotePgName(schema)}`)
  for (const table of req.tables ?? []) {
    args.push(`--table=${quotePgName(table.schema)}.${quotePgName(table.name)}`)
  }

  return { args, env: pgClientEnv(target) }
}

// ---------------------------------------------------------------------------
// Locating pg_dump
// ---------------------------------------------------------------------------

/** POWVIEW_PG_DUMP when set (a path or a command name), else pg_dump on PATH. Null when missing. */
export function locatePgDump(): string | null {
  const configured = process.env.POWVIEW_PG_DUMP?.trim()
  if (configured) return Bun.which(configured)
  return Bun.which('pg_dump')
}

async function pgDumpVersion(pgDump: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([pgDump, '--version'], {
      env: { PATH: childPath() },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = (await new Response(proc.stdout).text()).trim()
    if ((await proc.exited) !== 0) return null
    // "pg_dump (PostgreSQL) 18.1 (Debian 18.1-1.pgdg120+1)"
    return /\(PostgreSQL\)\s+(\S+)/.exec(out)?.[1] ?? (out || null)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function checkName(value: string, what: string): string {
  if (value.length > MAX_NAME_LENGTH || value.includes('\0')) throw badRequest(`${what} is not a valid name.`)
  return value
}

/** A comma separated list, trimmed, without empty or repeated items. */
function splitList(value: string | null): string[] {
  if (value === null) return []
  const items = [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
  if (items.length > MAX_LIST_ITEMS) throw badRequest(`Choose at most ${MAX_LIST_ITEMS} schemas or tables.`)
  return items
}

/** "schema.table". The first dot separates, so a table name may contain dots. */
function parseTable(item: string): { schema: string; name: string } {
  const dot = item.indexOf('.')
  if (dot <= 0 || dot === item.length - 1) throw badRequest(`tables must be schema.table (got "${item}").`)
  return {
    schema: checkName(item.slice(0, dot), 'Schema'),
    name: checkName(item.slice(dot + 1), 'Table'),
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null, fallback: T, what: string): T {
  if (value === null || value === '') return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw badRequest(`${what} must be one of: ${allowed.join(', ')}.`)
}

export function parseExportParams(params: URLSearchParams): DatabaseExportRequest {
  const connection = params.get('connection')?.trim()
  if (!connection) throw badRequest('connection is required.')
  const database = params.get('database')?.trim()
  if (!database) throw badRequest('database is required.')
  const schemas = splitList(params.get('schemas')).map((s) => checkName(s, 'Schema'))
  const tables = splitList(params.get('tables')).map(parseTable)
  if (schemas.length && tables.length) throw badRequest('Choose schemas or tables, not both.')
  return {
    connection,
    database: checkName(database, 'Database'),
    content: oneOf<ExportContent>(EXPORT_CONTENTS, params.get('content'), 'all', 'content'),
    format: oneOf<ExportFormat>(EXPORT_FORMATS, params.get('format'), 'sql', 'format'),
    schemas,
    tables,
  }
}

/** Downloads are named <database>-<YYYYMMDD-HHmm>.sql, .sql.gz or .dump; the name is plain ASCII. */
export function exportFilename(database: string, format: ExportFormat, now = new Date()): string {
  const safe = database.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'database'
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${safe}-${stamp}.${exportExtension(format)}`
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Signed-in users and the local CLI key only; API tokens (agents) are refused. `signIn` names the
 * action in the 401 message, `tokens` is the 403 message.
 */
export async function requireUser(request: Request, signIn: string, tokens: string): Promise<void> {
  const principal = await authenticate(request)
  if (!principal) throw new HttpError(401, 'unauthenticated', `Sign in, or send the local key, to ${signIn}.`)
  if (principal.kind !== 'user') throw new HttpError(403, 'forbidden', tokens)
}

/** A browser session cookie sent from another site is refused. */
export function checkOrigin(request: Request): void {
  if (readCookie(request, SESSION_COOKIE) !== null) guardOrigin(request)
}

export async function loadConnection(id: string): Promise<ConnectionConfig> {
  const conn = (await listConnections()).find((c) => c.id === id)
  if (!conn) throw new HttpError(404, 'not_found', 'Connection not found. It may have been deleted.')
  return conn
}

const EXPORT_SIGN_IN = 'export a database'
const EXPORT_TOKENS = 'Database exports are for signed-in users only. API tokens cannot export.'

/** GET /api/export/database: the dump as a download. */
export async function handleDatabaseExport(request: Request): Promise<Response> {
  try {
    await requireUser(request, EXPORT_SIGN_IN, EXPORT_TOKENS)
    checkOrigin(request)
    const req = parseExportParams(new URL(request.url).searchParams)
    const conn = await loadConnection(req.connection)
    const pgDump = locatePgDump()
    if (!pgDump) throw new HttpError(501, 'pg_dump_missing', PG_DUMP_MISSING_MESSAGE)
    const plan = buildDumpPlan(pgDump, await pgTarget(conn, req.database), req)
    return await streamDump(plan, request.signal, exportFilename(req.database, req.format), req.format)
  } catch (err) {
    return errorToResponse(err)
  }
}

/** GET /api/export/database/status: whether pg_dump is available, and its version. */
export async function handleDatabaseExportStatus(request: Request): Promise<Response> {
  try {
    await requireUser(request, EXPORT_SIGN_IN, EXPORT_TOKENS)
    const pgDump = locatePgDump()
    const version = pgDump ? await pgDumpVersion(pgDump) : null
    const body: PgDumpStatus = { available: version !== null, version }
    return jsonResponse(body, 200, { 'Cache-Control': 'no-store' })
  } catch (err) {
    return errorToResponse(err)
  }
}

/** The end of pg_dump's stderr for an error message. Secrets are hidden before the cut, so none is half shown. */
function lastLines(text: string, secrets: readonly (string | undefined)[]): string {
  return redactSecrets(text, secrets).trim().split('\n').slice(-8).join('\n').slice(-1000)
}

function spawnDump(plan: DumpPlan) {
  try {
    return Bun.spawn(plan.args, { env: plan.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch (err) {
    throw new HttpError(
      500,
      'pg_dump_failed',
      `pg_dump could not start: ${redactSecrets(err instanceof Error ? err.message : String(err), [plan.env.PGPASSWORD])}`,
    )
  }
}

/**
 * Starts pg_dump and streams its stdout. If it fails before writing anything, the response is
 * a 500 with the end of stderr. If it fails later, the stream ends and stderr goes to the log.
 * A client that goes away (abort or cancel) kills the process.
 */
async function streamDump(
  plan: DumpPlan,
  signal: AbortSignal,
  filename: string,
  format: ExportFormat,
): Promise<Response> {
  const proc = spawnDump(plan)
  const stderr = new Response(proc.stderr).text().catch(() => '')
  const kill = () => {
    try {
      proc.kill()
    } catch {
      // already exited
    }
  }
  let cancelled = false
  const abort = () => {
    cancelled = true
    kill()
  }
  signal.addEventListener('abort', abort, { once: true })

  const reader = proc.stdout.getReader()
  let first: Uint8Array | undefined
  let finished = false
  try {
    const chunk = await reader.read()
    if (chunk.done) finished = true
    else first = chunk.value
  } catch {
    kill()
    finished = true
  }

  if (finished) {
    signal.removeEventListener('abort', abort)
    const code = await proc.exited
    const message = await stderr
    if (code !== 0) {
      throw new HttpError(
        500,
        'pg_dump_failed',
        `pg_dump failed (exit ${code}).\n${lastLines(message, [plan.env.PGPASSWORD])}`,
      )
    }
    return new Response(null, { status: 200, headers: downloadHeaders(filename, format) })
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const send = (fn: () => void) => {
        try {
          fn()
        } catch {
          // the stream was cancelled meanwhile
        }
      }
      if (first) {
        const chunk = first
        first = undefined
        send(() => controller.enqueue(chunk))
        return
      }
      try {
        const next = await reader.read()
        if (next.done) {
          signal.removeEventListener('abort', abort)
          const code = await proc.exited
          if (code !== 0 && !cancelled) {
            console.error(
              `[powview] database export failed after the download started (pg_dump exit ${code}):\n${lastLines(await stderr, [plan.env.PGPASSWORD])}`,
            )
          }
          send(() => controller.close())
          return
        }
        send(() => controller.enqueue(next.value))
      } catch (err) {
        console.error('[powview] database export stream failed:', err)
        kill()
        send(() => controller.close())
      }
    },
    cancel() {
      cancelled = true
      signal.removeEventListener('abort', abort)
      kill()
    },
  })
  return new Response(body, { status: 200, headers: downloadHeaders(filename, format) })
}

function downloadHeaders(filename: string, format: ExportFormat): Record<string, string> {
  let contentType: string
  if (format === 'custom') contentType = 'application/octet-stream'
  else if (format === 'sql-gz') contentType = 'application/gzip'
  else contentType = 'application/sql; charset=utf-8'
  return {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
}
