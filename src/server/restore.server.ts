import { createWriteStream, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Subprocess } from 'bun'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import {
  RESTORE_FORMATS,
  RESTORE_SNIFF_BYTES,
  restoreFormatMismatch,
  type RestoreFormat,
  type RestoreResult,
} from '@/lib/db-restore'
import {
  checkOrigin,
  conninfo,
  loadConnection,
  locatePgDump,
  pgClientEnv,
  requireUser,
  type DumpTarget,
} from './dump.server'
import { pgTarget } from './pg-target.server'
import {
  HttpError,
  badRequest,
  checkDeclaredSize,
  envMegabytes,
  errorToResponse,
  fileTooLarge,
  flagParam,
  jsonResponse,
} from './http/util.server'

/**
 * Restore: a backup file (plain SQL, gzip SQL or pg_dump custom) is run into a database with
 * psql or pg_restore. The file is the request body. Arguments are always an array, the password
 * only travels in PGPASSWORD, and nothing runs until the first bytes match the chosen format.
 */

const DEFAULT_MAX_RESTORE_MB = 2048
const MIB = 1024 * 1024
/** lines of stderr returned in the response */
const LOG_LINES = 60
/** stderr kept in memory; the end is kept */
const STDERR_CAP = 200_000

type PgTool = 'psql' | 'pg_restore'

interface RestoreParams {
  connection: string
  database: string
  format: RestoreFormat
  /** one transaction; an error stops the run and undoes it */
  atomic: boolean
  /** pg_restore --clean --if-exists: drop each object before it is recreated (custom only) */
  clean: boolean
}

interface RestorePlan {
  args: string[]
  env: Record<string, string>
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export function parseRestoreParams(params: URLSearchParams): RestoreParams {
  const connection = params.get('connection')?.trim()
  if (!connection || connection.length > 200) throw badRequest('connection is required.')
  const database = params.get('database')?.trim()
  if (!database) throw badRequest('database is required.')
  if (database.length > 255 || database.includes('\0')) throw badRequest('database is not a valid name.')
  const format = params.get('format') ?? ''
  if (!(RESTORE_FORMATS as readonly string[]).includes(format)) {
    throw badRequest(`format must be one of: ${RESTORE_FORMATS.join(', ')}.`)
  }
  const atomic = flagParam(params, 'atomic')
  const clean = flagParam(params, 'clean')
  if (clean && format !== 'custom') throw badRequest('clean only applies to pg_dump custom files.')
  return { connection, database, format: format as RestoreFormat, atomic, clean }
}

/** Upper limit for the upload in MB. POWVIEW_MAX_RESTORE_MB, default 2048. */
export function restoreLimitMb(): number {
  return envMegabytes('POWVIEW_MAX_RESTORE_MB', DEFAULT_MAX_RESTORE_MB)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function toolFor(format: RestoreFormat): PgTool {
  return format === 'custom' ? 'pg_restore' : 'psql'
}

/**
 * Finds a PostgreSQL client program: in POWVIEW_PG_BIN when set, else next to the located pg_dump,
 * else on PATH. Null when it is not there.
 */
function locatePgTool(name: PgTool): string | null {
  const dir = process.env.POWVIEW_PG_BIN?.trim()
  if (dir) {
    const candidate = join(dir, name)
    return existsSync(candidate) ? candidate : null
  }
  const pgDump = locatePgDump()
  if (pgDump) {
    const candidate = join(dirname(pgDump), name)
    if (existsSync(candidate)) return candidate
  }
  return Bun.which(name)
}

function missingToolMessage(tool: PgTool): string {
  return `${tool} is not installed. The pow/view Docker image includes it; when running from source, install the PostgreSQL 18 client, or set POWVIEW_PG_BIN to the folder that holds it.`
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * The argument list and environment for one restore. Pure: no process is started.
 * `file` is the plain SQL (already decompressed) or the custom dump on disk.
 */
export function buildRestorePlan(
  binary: string,
  target: DumpTarget,
  req: Pick<RestoreParams, 'format' | 'atomic' | 'clean'>,
  file: string,
): RestorePlan {
  const args = [binary, `--dbname=${conninfo(target)}`, '--no-password']
  if (req.format === 'custom') {
    args.push('--no-owner', '--no-privileges')
    if (req.atomic) args.push('--single-transaction', '--exit-on-error')
    if (req.clean) args.push('--clean', '--if-exists')
    args.push(file)
  } else {
    args.push('--no-psqlrc', '--quiet', `--set=ON_ERROR_STOP=${req.atomic ? 1 : 0}`)
    if (req.atomic) args.push('--single-transaction')
    args.push(`--file=${file}`)
  }
  return { args, env: pgClientEnv(target) }
}

/** A line psql or pg_restore prints for an error. psql puts "psql:<file>:<line>: " in front of ERROR. */
const ERROR_LINE = /^(?:psql:[^\n]*?:\d+: )?ERROR:|^pg_restore: error:|^psql: error:/

export function isErrorLine(line: string): boolean {
  return ERROR_LINE.test(line)
}

function lastLines(text: string, count: number): string {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed === '') return ''
  return trimmed.split('\n').slice(-count).join('\n')
}

/** Collects stderr as it streams in: counts error lines, keeps the end of the text for the log. */
export class StderrTally {
  errors = 0
  private text = ''
  private partial = ''

  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-STDERR_CAP)
    const parts = (this.partial + chunk).split('\n')
    this.partial = parts.pop() ?? ''
    for (const line of parts) if (isErrorLine(line)) this.errors++
  }

  /** Call once the stream has ended, so an unterminated last line is counted too. */
  finish(): void {
    if (isErrorLine(this.partial)) this.errors++
    this.partial = ''
  }

  log(): string {
    return lastLines(this.text, LOG_LINES)
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Streams the request body into the file the tool reads. The first bytes must match the chosen
 * format (checked before anything else is written); a gzip file is decompressed on the way in.
 * Bytes are counted as they arrive, so a missing or wrong Content-Length cannot exceed the limit.
 */
async function receiveUpload(request: Request, file: string, format: RestoreFormat, limitMb: number): Promise<void> {
  if (!request.body) throw badRequest('The request has no file.')
  const limit = limitMb * MIB
  let bytes = 0
  let head: Buffer = Buffer.alloc(0)
  let checked = false

  const check = () => {
    checked = true
    if (bytes === 0) throw badRequest('The file is empty.')
    const mismatch = restoreFormatMismatch(head, format)
    if (mismatch) throw badRequest(mismatch)
  }

  const guard = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.byteLength
      if (bytes > limit) throw fileTooLarge(limitMb, 'POWVIEW_MAX_RESTORE_MB')
      if (!checked) {
        const need = RESTORE_SNIFF_BYTES - head.length
        head = Buffer.concat([head, chunk.subarray(0, need)])
        if (head.length >= RESTORE_SNIFF_BYTES) check()
      }
      yield chunk
    }
    if (!checked) check()
  }

  const source = Readable.fromWeb(request.body as unknown as WebReadableStream<Uint8Array>)
  const sink = createWriteStream(file, { flags: 'wx', mode: 0o600 })
  try {
    if (format === 'sql-gz') await pipeline(source, guard, createGunzip(), sink, { signal: request.signal })
    else await pipeline(source, guard, sink, { signal: request.signal })
  } catch (err) {
    throw uploadError(err, request.signal)
  }
}

function uploadError(err: unknown, signal: AbortSignal): unknown {
  if (err instanceof HttpError) return err
  if (signal.aborted) return new HttpError(400, 'aborted', 'The upload was cancelled.')
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.startsWith('Z_')) {
    return badRequest('The compressed file is damaged or incomplete.')
  }
  return err
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface RunOutcome {
  exitCode: number
  errors: number
  log: string
}

/** Runs the tool. A client that goes away kills it (so an atomic restore rolls back). */
async function runTool(plan: RestorePlan, signal: AbortSignal): Promise<RunOutcome> {
  let proc: Subprocess<'ignore', 'ignore', 'pipe'>
  try {
    // stdout is ignored: psql prints the result rows of the dump's SELECT statements there
    proc = Bun.spawn(plan.args, { env: plan.env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  } catch (err) {
    throw new HttpError(
      500,
      'restore_failed',
      `${plan.args[0]} could not start: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const reader = proc.stderr.getReader()
  const kill = () => {
    try {
      proc.kill()
    } catch {
      // already exited
    }
    // a grandchild that inherited stderr must not hold the response open
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', kill, { once: true })
  try {
    const tally = new StderrTally()
    const decoder = new TextDecoder('utf-8')
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      tally.push(decoder.decode(value, { stream: true }))
    }
    tally.push(decoder.decode())
    tally.finish()
    const exitCode = await proc.exited
    if (signal.aborted) throw new HttpError(400, 'aborted', 'The restore was cancelled.')
    return { exitCode, errors: tally.errors, log: tally.log() }
  } finally {
    signal.removeEventListener('abort', kill)
  }
}

/** 200 when the tool exited 0. Otherwise 422 with the same fields and an error message. */
export function restoreResponse(atomic: boolean, outcome: RunOutcome): Response {
  const body: RestoreResult = {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    errors: outcome.errors,
    log: outcome.log,
  }
  const headers = { 'Cache-Control': 'no-store' }
  if (outcome.exitCode === 0) return jsonResponse(body, 200, headers)
  const message = atomic
    ? 'The restore stopped with an error. Nothing was changed.'
    : 'The restore finished with errors.'
  return Response.json({ ...body, error: { code: 'restore_failed', message } }, { status: 422, headers })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** POST /api/import/restore: the query string says where, the body is the backup file. */
export async function handleRestore(request: Request): Promise<Response> {
  try {
    await requireUser(request, 'restore a database', 'Restore is for signed-in users only. API tokens cannot restore.')
    checkOrigin(request)
    const req = parseRestoreParams(new URL(request.url).searchParams)
    const conn = await loadConnection(req.connection)
    if (conn.readOnly) throw new HttpError(403, 'read_only', 'This connection is read-only.')
    const limitMb = restoreLimitMb()
    checkDeclaredSize(request, limitMb, 'POWVIEW_MAX_RESTORE_MB')
    const tool = toolFor(req.format)
    const binary = locatePgTool(tool)
    if (!binary) throw new HttpError(501, 'pg_tools_missing', missingToolMessage(tool))

    // a fresh directory per restore: the file never has a name the client chose
    const dir = await mkdtemp(join(tmpdir(), 'powview-restore-'))
    try {
      const file = join(dir, req.format === 'custom' ? 'dump.dump' : 'dump.sql')
      await receiveUpload(request, file, req.format, limitMb)
      const target = await pgTarget(conn, req.database)
      const plan = buildRestorePlan(binary, target, req, file)
      const outcome = await runTool(plan, request.signal)
      // psql prefixes errors with its input path (a temp file here): show just the line number
      outcome.log = tidyLog(outcome.log, file)
      return restoreResponse(req.atomic, outcome)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } catch (err) {
    return errorToResponse(err)
  }
}

/** `psql:/tmp/powview-restore-x/dump.sql:26: ERROR: ...` becomes `line 26: ERROR: ...`. */
export function tidyLog(log: string, file: string): string {
  return log.split(`psql:${file}:`).join('line ').split(file).join('the file')
}
