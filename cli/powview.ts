/// <reference types="bun" />
// powview: command-line client for PowView. It talks only to the HTTP API and the
// MCP endpoint of a running server. It never imports server modules.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as readline from 'node:readline'
import { rm } from 'node:fs/promises'
import {
  EXPORT_CONTENTS,
  EXPORT_FORMATS,
  PG_DUMP_MISSING_MESSAGE,
  databaseExportUrl,
  exportExtension,
  type ExportContent,
  type ExportFormat,
  type PgDumpStatus,
} from '../src/lib/db-export'
import { RESTORE_SNIFF_BYTES, detectRestoreFormat, restoreUrl, type RestoreResult } from '../src/lib/db-restore'
import { TABLE_EXPORT_FORMATS } from '../src/lib/table-export'
import { expiryStatus } from '../src/lib/token-expiry'
import type {
  Access,
  ApiTokenInfo,
  AuditEntry,
  AuthState,
  ConnectionInfo,
  SshInfo,
  TestConnectionResult,
} from '../src/lib/types'

type RestoreReply = Partial<RestoreResult> & { error?: { message?: string } }

// ---------------------------------------------------------------------------
// Types of responses the CLI reads (the server-side types are not importable)
// ---------------------------------------------------------------------------

type ConnectionRow = ConnectionInfo & { access: Access }

interface TableSummary {
  schema: string
  name: string
  kind: string
  estimatedRows: number | null
  comment: string | null
}

interface ColumnDescription {
  name: string
  type: string
  nullable: boolean
  default: string | null
  primaryKey: boolean
  references: { schema: string; table: string; column: string } | null
}

interface TableDescription {
  schema: string
  name: string
  kind: string
  comment: string | null
  columns: ColumnDescription[]
  indexes: { name: string; definition: string }[]
}

interface QueryResult {
  columns: { name: string; type: string }[]
  rows: Record<string, string | null>[]
  rowCount: number | null
  truncated: boolean
  durationMs: number
  command: string | null
}

interface TokenCreated {
  token: string
  info: ApiTokenInfo
}

// ---------------------------------------------------------------------------
// Configuration and auth
// ---------------------------------------------------------------------------

const SIGN_IN_HINT = [
  "Not signed in. Set POWVIEW_TOKEN to an API token, or run powview where POWVIEW_DATA_DIR points at PowView's data folder.",
  'In Docker: docker exec powview powview <command>.',
]

function serverUrl(): string {
  const base = process.env.POWVIEW_URL?.trim() || `http://127.0.0.1:${process.env.PORT || '3333'}`
  return base.replace(/\/+$/, '')
}

function localKeyRejected(): string {
  return `The local key in ${localKeyPath()} was not accepted. Check that POWVIEW_DATA_DIR points at PowView's data folder.`
}

function dataDir(): string {
  return process.env.POWVIEW_DATA_DIR || './.data'
}

function localKeyPath(): string {
  return join(dataDir(), 'auth.json')
}

function readLocalKey(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(localKeyPath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && 'localKey' in parsed) {
      const key = parsed.localKey
      if (typeof key === 'string' && key !== '') return key
    }
  } catch {
    // Missing or unreadable: there is no local key.
  }
  return undefined
}

/**
 * default: POWVIEW_TOKEN if set, else the local key, else no header.
 * local: always the local key (admin reset-password), fails when there is none.
 * none: no auth header at all.
 */
type AuthMode = 'default' | 'local' | 'none'

function authHeaders(mode: AuthMode = 'default'): Record<string, string> {
  if (mode === 'none') return {}
  if (mode === 'default') {
    const token = process.env.POWVIEW_TOKEN
    if (token) return { Authorization: `Bearer ${token}` }
  }
  const key = readLocalKey()
  if (!key) {
    if (mode === 'local') {
      throw new Error(
        `No local key found in ${localKeyPath()}. Run this where POWVIEW_DATA_DIR points at PowView's data folder.`,
      )
    }
    return {}
  }
  return { 'X-PowView-Local-Key': key }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class NetworkError extends Error {}

interface RawResponse {
  status: number
  text: string
}

function unreachable(): NetworkError {
  return new NetworkError(
    `Cannot reach PowView at ${serverUrl()}. Is the server running? Set POWVIEW_URL if it runs somewhere else.`,
  )
}

/** Sends one request. Throws NetworkError when the server cannot be reached. */
async function rawRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  const init: RequestInit =
    body === undefined
      ? { method, headers }
      : { method, headers: { ...headers, 'Content-Type': 'application/json' }, body }
  try {
    const res = await fetch(serverUrl() + path, init)
    return { status: res.status, text: await res.text() }
  } catch {
    throw unreachable()
  }
}

/** The `message` of a { error: { code, message } } body, when the body has that shape. */
function apiErrorMessage(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text)
    if (body && typeof body === 'object' && 'error' in body) {
      const err = body.error
      if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
        return err.message
      }
    }
  } catch {
    // Not JSON: fall through.
  }
  return undefined
}

function errorMessage(res: RawResponse): string {
  const message = apiErrorMessage(res.text)
  if (message) return message
  const text = res.text.trim().slice(0, 300)
  return text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status}`
}

/** JSON API call. Throws an Error with a user-facing message on any failure. */
async function api<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; auth?: AuthMode } = {},
): Promise<T> {
  const mode = options.auth ?? 'default'
  const body = method === 'GET' ? undefined : JSON.stringify(options.body ?? {})
  const res = await rawRequest(method, path, authHeaders(mode), body)
  if (res.status === 401) throw new Error(mode === 'local' ? localKeyRejected() : SIGN_IN_HINT.join('\n'))
  if (res.status < 200 || res.status > 299) throw new Error(errorMessage(res))
  try {
    return JSON.parse(res.text) as T
  } catch {
    throw new Error('PowView sent a response that is not JSON.')
  }
}

function connPath(ref: string): string {
  return `/api/v1/connections/${encodeURIComponent(ref)}`
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** 'list' flags can be repeated; every value is kept, in order. */
type FlagKind = 'bool' | 'value' | 'list'

interface Parsed {
  positional: string[]
  flags: Record<string, string | true>
  lists: Record<string, string[]>
}

/** Parses `--flag value`, `--flag=value`, repeated `list` flags and boolean flags. `--` ends flag parsing. */
function parseArgs(args: string[], spec: Record<string, FlagKind>): Parsed {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  const lists: Record<string, string[]> = {}
  let onlyPositional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (onlyPositional || arg === '-' || !arg.startsWith('-')) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      onlyPositional = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!Object.hasOwn(spec, name)) throw new Error(`Unknown option: --${name}`)
    if (spec[name] === 'bool') {
      if (eq !== -1) throw new Error(`--${name} does not take a value.`)
      flags[name] = true
    } else {
      let value: string
      if (eq !== -1) {
        value = arg.slice(eq + 1)
      } else {
        const next = args[i + 1]
        if (next === undefined) throw new Error(`--${name} needs a value.`)
        value = next
        i++
      }
      if (spec[name] === 'list') (lists[name] ??= []).push(value)
      else flags[name] = value
    }
  }
  return { positional, flags, lists }
}

function positionals(p: Parsed, labels: string[]): string[] {
  if (p.positional.length < labels.length) {
    throw new Error(`Missing <${labels[p.positional.length]}>. Run powview help for usage.`)
  }
  const extra = p.positional[labels.length]
  if (extra !== undefined) throw new Error(`Unexpected argument: ${extra}`)
  return p.positional
}

function str(p: Parsed, name: string): string | undefined {
  const value = p.flags[name]
  return typeof value === 'string' ? value : undefined
}

function bool(p: Parsed, name: string): boolean {
  return p.flags[name] === true
}

function strList(p: Parsed, name: string): string[] {
  return p.lists[name] ?? []
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number of at least 1.`)
  return n
}

function setIf(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) body[key] = value
}

function stripOneNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function print(line = ''): void {
  process.stdout.write(line + '\n')
}

function printError(line: string): void {
  process.stderr.write(line + '\n')
}

function printJson(value: unknown): void {
  print(JSON.stringify(value, null, 2))
}

function printFields(pairs: [string, string][]): void {
  const width = Math.max(...pairs.map(([label]) => label.length)) + 2
  for (const [label, value] of pairs) print(label.padEnd(width) + value)
}

function cleanLine(text: string): string {
  return text.replace(/\p{Cc}/gu, ' ')
}

function cell(text: string): string {
  const clean = cleanLine(text)
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean
}

function renderTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows].map((row) => row.map(cell))
  const widths = headers.map((_, i) => Math.max(...all.map((row) => (row[i] ?? '').length)))
  return all
    .map((row) => row.map((value, i) => (i === row.length - 1 ? value : value.padEnd(widths[i]))).join('  '))
    .join('\n')
}

function shortTime(iso: string): string {
  return iso.slice(0, 19)
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function cmdStatus(args: string[]): Promise<void> {
  const p = parseArgs(args, { json: 'bool' })
  positionals(p, [])
  const url = serverUrl()
  const state = await api<AuthState>('GET', '/api/auth/state', { auth: 'none' })
  const probe = await rawRequest('GET', '/api/v1/connections', authHeaders())
  const cliOk = probe.status >= 200 && probe.status <= 299

  if (bool(p, 'json')) {
    printJson({ url, state, cliAccess: cliOk })
    return
  }
  print(`Server: ${url}`)
  print(`Auth enabled: ${yesNo(state.authEnabled)}`)
  print(`Admin set up: ${yesNo(!state.setupRequired)}`)
  if (cliOk) {
    print('CLI access: ok')
  } else if (probe.status === 401) {
    print('CLI access: no (see the sign-in hint)')
    SIGN_IN_HINT.forEach((line) => print(line))
  } else {
    print(`CLI access: no (HTTP ${probe.status})`)
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function cmdConnList(args: string[]): Promise<void> {
  const p = parseArgs(args, { json: 'bool' })
  positionals(p, [])
  const rows = await api<ConnectionRow[]>('GET', '/api/v1/connections')
  if (bool(p, 'json')) return printJson(rows)
  if (rows.length === 0) return print('No connections yet. Add one with: powview conn add <url>')
  print(
    renderTable(
      ['ID', 'NAME', 'HOST', 'DATABASE', 'USER', 'AI', 'READ ONLY', 'PROD', 'ACCESS', 'MANAGED'],
      rows.map((c) => [
        c.id,
        c.name,
        `${c.host}:${c.port}`,
        c.database,
        c.user,
        c.aiAccess,
        yesNo(c.readOnly),
        yesNo(c.production === true),
        c.access,
        yesNo(c.managed === true),
      ]),
    ),
  )
}

/** user@host or user@host:port (port defaults to 22). IPv6 hosts go in brackets. */
function parseSshTarget(value: string): { user: string; host: string; port: number } {
  const m = /^([^@\s]+)@(\[[^\]\s]+\]|[^:@\s]+)(?::(\d+))?$/.exec(value)
  if (!m) throw new Error('--ssh must be user@host or user@host:port, for example deploy@bastion.example.com:2222.')
  const port = m[3] === undefined ? 22 : Number(m[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The SSH port must be between 1 and 65535.')
  return { user: m[1]!, host: m[2]!.replace(/^\[|\]$/g, ''), port }
}

async function readKeyFile(file: string): Promise<string> {
  try {
    return await Bun.file(file).text()
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`)
  }
}

/**
 * The ssh object for the API from --ssh, --ssh-key and --ssh-password-stdin. `base` is the
 * saved tunnel when editing: its host, port and user are used when --ssh is not given, and its
 * login method when no secret is given (the saved secret is then kept).
 */
async function readSshBody(p: Parsed, base: SshInfo | undefined): Promise<Record<string, unknown> | undefined> {
  const target = str(p, 'ssh')
  const keyFile = str(p, 'ssh-key')
  const passwordStdin = bool(p, 'ssh-password-stdin')
  if (keyFile !== undefined && passwordStdin) {
    throw new Error('Pass either --ssh-key or --ssh-password-stdin, not both.')
  }
  const hasSecret = keyFile !== undefined || passwordStdin
  if (target === undefined && !hasSecret) return undefined

  let where: { host: string; port: number; user: string }
  if (target !== undefined) where = parseSshTarget(target)
  else if (base) where = { host: base.host, port: base.port, user: base.user }
  else throw new Error('Pass --ssh user@host[:port] first.')

  const body: Record<string, unknown> = { ...where }
  if (keyFile !== undefined) {
    body.auth = 'key'
    body.privateKey = await readKeyFile(keyFile)
  } else if (passwordStdin) {
    body.auth = 'password'
    body.password = stripOneNewline(await Bun.stdin.text())
  } else {
    if (!base) throw new Error('Pass --ssh-key FILE or --ssh-password-stdin to log in to the SSH server.')
    body.auth = base.auth
  }
  return body
}

/**
 * The saved connection a reference names: an id, or a name that is unique. The server applies the
 * same rule. Export, dump and restore need the local key (`auth`), since their routes take only that.
 */
async function findConnectionRow(ref: string, auth: AuthMode = 'default'): Promise<ConnectionRow> {
  const rows = await api<ConnectionRow[]>('GET', '/api/v1/connections', { auth })
  const byName = rows.filter((c) => c.name === ref)
  const found = rows.find((c) => c.id === ref) ?? (byName.length === 1 ? byName[0] : undefined)
  if (!found) {
    if (byName.length > 1) throw new Error(`More than one connection is named "${ref}". Use its id instead.`)
    throw new Error(`No connection matches "${ref}". Run powview conn list.`)
  }
  return found
}

async function cmdConnAdd(args: string[]): Promise<void> {
  const p = parseArgs(args, {
    name: 'value',
    'read-only': 'bool',
    production: 'bool',
    ai: 'value',
    color: 'value',
    'password-stdin': 'bool',
    ssh: 'value',
    'ssh-key': 'value',
    'ssh-password-stdin': 'bool',
    json: 'bool',
  })
  const [url] = positionals(p, ['url'])
  if (bool(p, 'password-stdin') && bool(p, 'ssh-password-stdin')) {
    throw new Error('Pass either --password-stdin or --ssh-password-stdin, not both. Both read stdin.')
  }
  const body: Record<string, unknown> = { url }
  setIf(body, 'name', str(p, 'name'))
  if (bool(p, 'read-only')) body.readOnly = true
  if (bool(p, 'production')) body.production = true
  setIf(body, 'aiAccess', str(p, 'ai'))
  setIf(body, 'color', str(p, 'color'))
  if (bool(p, 'password-stdin')) body.password = stripOneNewline(await Bun.stdin.text())
  const ssh = await readSshBody(p, undefined)
  if (ssh) body.ssh = ssh

  const info = await api<ConnectionInfo>('POST', '/api/v1/connections', { body })
  if (bool(p, 'json')) return printJson(info)
  print(`Added ${info.name} (id ${info.id}).`)
}

async function cmdConnEdit(args: string[]): Promise<void> {
  const p = parseArgs(args, {
    name: 'value',
    url: 'value',
    'read-only': 'bool',
    writable: 'bool',
    production: 'bool',
    'not-production': 'bool',
    ai: 'value',
    ssh: 'value',
    'ssh-key': 'value',
    'ssh-password-stdin': 'bool',
    'no-ssh': 'bool',
    json: 'bool',
  })
  const [ref] = positionals(p, ['id|name'])
  if (bool(p, 'read-only') && bool(p, 'writable')) {
    throw new Error('Pass either --read-only or --writable, not both.')
  }
  if (bool(p, 'production') && bool(p, 'not-production')) {
    throw new Error('Pass either --production or --not-production, not both.')
  }
  const sshFlags = str(p, 'ssh') !== undefined || str(p, 'ssh-key') !== undefined || bool(p, 'ssh-password-stdin')
  if (bool(p, 'no-ssh') && sshFlags) {
    throw new Error('--no-ssh cannot be combined with --ssh, --ssh-key or --ssh-password-stdin.')
  }
  const body: Record<string, unknown> = {}
  setIf(body, 'name', str(p, 'name'))
  setIf(body, 'url', str(p, 'url'))
  if (bool(p, 'read-only')) body.readOnly = true
  if (bool(p, 'writable')) body.readOnly = false
  if (bool(p, 'production')) body.production = true
  if (bool(p, 'not-production')) body.production = false
  setIf(body, 'aiAccess', str(p, 'ai'))
  if (bool(p, 'no-ssh')) body.ssh = null
  else if (sshFlags) {
    const current = await findConnectionRow(ref!)
    const ssh = await readSshBody(p, current.ssh)
    if (ssh) body.ssh = ssh
  }

  const info = await api<ConnectionInfo>('PATCH', connPath(ref), { body })
  if (bool(p, 'json')) return printJson(info)
  print(`Updated ${info.name}.`)
}

/** Asks one question on the terminal and resolves with the answer ('' if input closes). */
function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    let answer = ''
    rl.question(question, (text) => {
      answer = text
      rl.close()
    })
    rl.once('close', () => resolve(answer))
  })
}

async function cmdConnRemove(args: string[]): Promise<void> {
  const p = parseArgs(args, { yes: 'bool' })
  const [ref] = positionals(p, ['id|name'])
  if (!bool(p, 'yes')) {
    if (!process.stdin.isTTY) {
      throw new Error('Pass --yes to remove without a prompt when there is no terminal.')
    }
    const answer = await askLine(`Remove ${ref}? Type y to confirm: `)
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      print('Not removed.')
      return
    }
  }
  await api('DELETE', connPath(ref))
  print(`Removed ${ref}.`)
}

async function cmdConnTest(args: string[]): Promise<void> {
  const p = parseArgs(args, {})
  const [ref] = positionals(p, ['id|name'])
  const result = await api<TestConnectionResult>('POST', `${connPath(ref)}/test`)
  if (result.ok) {
    print(`OK: ${result.serverVersion ?? 'unknown version'} (${result.latencyMs ?? '?'} ms)`)
    return
  }
  printError(`Failed: ${result.error ?? 'unknown error'}`)
  process.exitCode = 1
}

// ---------------------------------------------------------------------------
// Schema and queries
// ---------------------------------------------------------------------------

async function cmdTables(args: string[]): Promise<void> {
  const p = parseArgs(args, { schema: 'value', json: 'bool' })
  const [conn] = positionals(p, ['conn'])
  const schema = str(p, 'schema')
  const query = schema === undefined ? '' : `?schema=${encodeURIComponent(schema)}`
  const tables = await api<TableSummary[]>('GET', `${connPath(conn)}/tables${query}`)
  if (bool(p, 'json')) return printJson(tables)
  if (tables.length === 0) return print('No tables found.')
  print(
    renderTable(
      ['SCHEMA', 'NAME', 'KIND', 'ROWS', 'COMMENT'],
      tables.map((t) => [
        t.schema,
        t.name,
        t.kind,
        t.estimatedRows === null ? '' : String(t.estimatedRows),
        t.comment ?? '',
      ]),
    ),
  )
}

function tableRef(arg: string, schemaFlag: string | undefined): { schema: string; name: string } {
  if (schemaFlag !== undefined) return { schema: schemaFlag, name: arg }
  const dot = arg.indexOf('.')
  if (dot === -1) return { schema: 'public', name: arg }
  return { schema: arg.slice(0, dot), name: arg.slice(dot + 1) }
}

async function cmdDescribe(args: string[]): Promise<void> {
  const p = parseArgs(args, { schema: 'value', json: 'bool' })
  const [conn, tableArg] = positionals(p, ['conn', 'table'])
  const { schema, name } = tableRef(tableArg, str(p, 'schema'))
  const path = `${connPath(conn)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`
  const d = await api<TableDescription>('GET', path)
  if (bool(p, 'json')) return printJson(d)

  print(`${d.schema}.${d.name}`)
  print()
  print(
    renderTable(
      ['NAME', 'TYPE', 'NULL', 'DEFAULT', 'KEY', 'REFERENCES'],
      d.columns.map((c) => [
        c.name,
        c.type,
        yesNo(c.nullable),
        c.default ?? '',
        c.primaryKey ? 'PK' : '',
        c.references ? `${c.references.schema}.${c.references.table}(${c.references.column})` : '',
      ]),
    ),
  )
  if (d.indexes.length > 0) {
    print()
    print('INDEXES')
    for (const index of d.indexes) {
      print(`  ${cleanLine(index.name)}`)
      print(`    ${cleanLine(index.definition)}`)
    }
  }
}

function printQueryResult(r: QueryResult): void {
  const ms = `${r.durationMs} ms`
  if (r.columns.length === 0) {
    const parts = [r.command ?? 'Done']
    if (typeof r.rowCount === 'number') parts.push(`${r.rowCount} rows affected`)
    parts.push(ms)
    print(parts.join(' · '))
    return
  }
  const headers = r.columns.map((c) => c.name)
  const rows = r.rows.map((row) => r.columns.map((c) => row[c.name] ?? 'NULL'))
  print(renderTable(headers, rows))
  if (r.truncated) {
    print(`first ${r.rows.length} rows shown · ${ms}`)
  } else {
    const count = r.rowCount ?? r.rows.length
    print(`${count} ${count === 1 ? 'row' : 'rows'} · ${ms}`)
  }
}

async function cmdQuery(args: string[]): Promise<void> {
  const p = parseArgs(args, { write: 'bool', json: 'bool', 'max-rows': 'value' })
  const [conn, sql] = positionals(p, ['conn', 'sql'])
  const body: Record<string, unknown> = { connection: conn, sql }
  if (bool(p, 'write')) body.write = true
  const maxRows = str(p, 'max-rows')
  if (maxRows !== undefined) body.maxRows = parsePositiveInt(maxRows, '--max-rows')

  const result = await api<QueryResult>('POST', '/api/v1/query', { body })
  if (bool(p, 'json')) return printJson(result)
  printQueryResult(result)
}

// ---------------------------------------------------------------------------
// Export and dump (streamed to a file or stdout)
// ---------------------------------------------------------------------------

function safeFileBase(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** YYYYMMDD-HHmm, the same stamp the browser download uses. */
function fileStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * Starts a download. The export routes take the local key only (API tokens get 403 there), so
 * this never falls back to POWVIEW_TOKEN. A non-2xx answer becomes an Error with the API's message.
 */
async function openDownload(path: string): Promise<Response> {
  const headers = authHeaders('local')
  let res: Response
  try {
    res = await fetch(serverUrl() + path, { headers })
  } catch {
    throw unreachable()
  }
  if (res.ok) return res
  if (res.status === 401) throw new Error(localKeyRejected())
  throw new Error(errorMessage({ status: res.status, text: await res.text() }))
}

/**
 * Copies a response body to a file, or to stdout when output is "-", one chunk at a time so the
 * whole download is never held in memory. A failed file write is removed. Returns the byte count.
 */
async function saveBody(res: Response, output: string): Promise<number> {
  const toStdout = output === '-'
  const writer = toStdout ? Bun.stdout.writer() : Bun.file(output).writer()
  let bytes = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (res.body) {
      reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
        bytes += value.byteLength
      }
    }
    if (toStdout) await writer.flush()
    else await writer.end()
  } catch (err) {
    // Stop the download too, so the server does not keep sending into a file that is gone.
    await reader?.cancel().catch(() => {})
    if (!toStdout) {
      try {
        await writer.end()
      } catch {
        // already closed
      }
      await rm(output, { force: true })
    }
    throw err
  }
  return bytes
}

/** `--table` / `--schema` names are joined with commas for the API, so they cannot contain one. */
function checkNoComma(value: string, flag: string): string {
  if (value.includes(',')) throw new Error(`${flag} names cannot contain a comma.`)
  return value
}

async function cmdExport(args: string[]): Promise<void> {
  const p = parseArgs(args, { schema: 'value', format: 'value', where: 'value', output: 'value' })
  const [conn, tableArg] = positionals(p, ['conn', 'table'])
  const { schema, name } = tableRef(tableArg, str(p, 'schema'))
  const format = str(p, 'format') ?? 'csv'
  if (!(TABLE_EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error('--format must be csv, json, ndjson or sql.')
  }
  const params = new URLSearchParams({ connection: conn, schema, table: name, format })
  const where = str(p, 'where')
  if (where !== undefined) params.set('where', where)
  const output = str(p, 'output') ?? `${safeFileBase(name)}.${format}`

  const res = await openDownload(`/api/export/table?${params.toString()}`)
  const bytes = await saveBody(res, output)
  if (output !== '-') printError(`Saved ${output} (${formatBytes(bytes)})`)
}

/** `schema.table`; the first dot separates, as the API does. */
function parseTableArg(item: string): { schema: string; name: string } {
  const dot = item.indexOf('.')
  if (dot <= 0 || dot === item.length - 1) throw new Error(`--table takes schema.table (got "${item}").`)
  return {
    schema: checkNoComma(item.slice(0, dot), '--table'),
    name: checkNoComma(item.slice(dot + 1), '--table'),
  }
}

async function cmdDump(args: string[]): Promise<void> {
  const p = parseArgs(args, {
    database: 'value',
    content: 'value',
    format: 'value',
    schema: 'list',
    table: 'list',
    output: 'value',
  })
  const [conn] = positionals(p, ['conn'])
  const content = str(p, 'content') ?? 'all'
  if (!(EXPORT_CONTENTS as readonly string[]).includes(content)) {
    throw new Error('--content must be all, schema or data.')
  }
  const format = str(p, 'format') ?? 'sql'
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error('--format must be sql, sql-gz or custom.')
  }
  const schemas = strList(p, 'schema').map((s) => checkNoComma(s, '--schema'))
  const tables = strList(p, 'table').map(parseTableArg)
  if (schemas.length > 0 && tables.length > 0) {
    throw new Error('Choose --schema or --table, not both. pg_dump cannot combine them.')
  }

  // The dump route takes a connection id (not a name), and needs the database. Without
  // --database, the connection's own database is used.
  const found = await findConnectionRow(conn, 'local')
  const database = str(p, 'database') ?? found.database

  const status = await api<PgDumpStatus>('GET', '/api/export/database/status', { auth: 'local' })
  if (!status.available) throw new Error(PG_DUMP_MISSING_MESSAGE)

  const output =
    str(p, 'output') ?? `${safeFileBase(database)}-${fileStamp()}.${exportExtension(format as ExportFormat)}`
  const path = databaseExportUrl({
    connection: found.id,
    database,
    content: content as ExportContent,
    format: format as ExportFormat,
    schemas,
    tables,
  })
  const res = await openDownload(path)
  const bytes = await saveBody(res, output)
  if (output !== '-') printError(`Saved ${output} (${formatBytes(bytes)})`)
}

/**
 * Restores a backup file into a database. The format comes from the file's first bytes, the same
 * way the browser dialog reads it. Nothing is asked: the flags are the confirmation.
 */
async function cmdRestore(args: string[]): Promise<void> {
  const p = parseArgs(args, { database: 'value', 'keep-going': 'bool', clean: 'bool' })
  const [conn, file] = positionals(p, ['conn', 'file'])
  const found = await findConnectionRow(conn, 'local')
  const database = str(p, 'database') ?? found.database
  const atomic = !bool(p, 'keep-going')
  const clean = bool(p, 'clean')

  const upload = Bun.file(file)
  if (!(await upload.exists())) throw new Error(`No file at ${file}.`)
  const format = detectRestoreFormat(new Uint8Array(await upload.slice(0, RESTORE_SNIFF_BYTES).arrayBuffer()))
  if (clean && format !== 'custom') throw new Error('--clean only works with pg_dump custom files.')

  const url = restoreUrl({ connection: found.id, database, format, atomic, clean })
  let res: Response
  try {
    res = await fetch(serverUrl() + url, {
      method: 'POST',
      headers: { ...authHeaders('local'), 'Content-Type': 'application/octet-stream' },
      body: upload,
    })
  } catch {
    throw unreachable()
  }
  const text = await res.text()
  if (res.status === 401) throw new Error(localKeyRejected())
  let body: RestoreReply = {}
  try {
    body = JSON.parse(text) as RestoreReply
  } catch {
    // not JSON: the error text is reported below
  }
  // the tool's log comes first, so the reason is above the error line
  for (const line of (body.log ?? '').split('\n')) if (line !== '') printError(line)
  if (!res.ok) throw new Error(body.error?.message ?? errorMessage({ status: res.status, text }))

  const errors = body.errors ?? 0
  if (errors > 0) {
    process.exitCode = 1
    printError(`Restore finished with ${errors} ${errors === 1 ? 'error' : 'errors'}.`)
    return
  }
  printError(`Restored ${file} into ${database}.`)
}

// ---------------------------------------------------------------------------
// API tokens and audit
// ---------------------------------------------------------------------------

/** --expires: 30d, 90d, 1y, never, or any whole number of days (1d to 3650d). null = never. */
function parseExpires(raw: string): number | null {
  const value = raw.trim().toLowerCase()
  if (value === 'never') return null
  if (value === '1y') return 365
  const match = /^(\d+)d$/.exec(value)
  const days = match ? Number(match[1]) : Number.NaN
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('--expires takes 30d, 90d, 1y, never, or a number of days from 1d to 3650d.')
  }
  return days
}

function printTokenInfo(info: ApiTokenInfo): void {
  printFields([
    ['ID', info.id],
    ['Name', info.name],
    ['Scope', info.scope],
    ['Connections', info.connections === 'all' ? 'all' : info.connections.join(',')],
    ['Expires', info.expiresAt ? `${shortTime(info.expiresAt)} (${expiryStatus(info.expiresAt).text})` : 'never'],
  ])
}

async function cmdTokenCreate(args: string[]): Promise<void> {
  const p = parseArgs(args, { scope: 'value', conn: 'value', expires: 'value', json: 'bool' })
  const [name] = positionals(p, ['name'])
  // Options left out are not sent, so the server applies its own defaults.
  const connFlag = str(p, 'conn')
  let connections: string[] | undefined
  if (connFlag !== undefined) {
    connections = connFlag
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
    if (connections.length === 0) throw new Error('--conn needs at least one connection id or name.')
  }
  const expiresFlag = str(p, 'expires')
  const expiresInDays = expiresFlag === undefined ? undefined : parseExpires(expiresFlag)

  const created = await api<TokenCreated>('POST', '/api/v1/tokens', {
    body: { name, scope: str(p, 'scope'), connections, expiresInDays },
  })
  if (bool(p, 'json')) return printJson(created)
  print(created.token)
  print()
  print('Save this token now. It is shown only once.')
  printTokenInfo(created.info)
}

async function cmdTokenList(args: string[]): Promise<void> {
  const p = parseArgs(args, { json: 'bool' })
  positionals(p, [])
  const tokens = await api<ApiTokenInfo[]>('GET', '/api/v1/tokens')
  if (bool(p, 'json')) return printJson(tokens)
  if (tokens.length === 0) return print('No API tokens yet. Create one with: powview token create <name>')
  print(
    renderTable(
      ['ID', 'NAME', 'PREFIX', 'SCOPE', 'CONNECTIONS', 'CREATED', 'LAST USED', 'EXPIRES'],
      tokens.map((t) => [
        t.id,
        t.name,
        t.prefix,
        t.scope,
        t.connections === 'all' ? 'all' : t.connections.join(','),
        shortTime(t.createdAt),
        t.lastUsedAt ? shortTime(t.lastUsedAt) : 'never',
        expiryStatus(t.expiresAt).text,
      ]),
    ),
  )
}

async function cmdTokenRevoke(args: string[]): Promise<void> {
  const p = parseArgs(args, {})
  const [id] = positionals(p, ['id'])
  await api('DELETE', `/api/v1/tokens/${encodeURIComponent(id)}`)
  print(`Revoked token ${id}.`)
}

async function cmdAudit(args: string[]): Promise<void> {
  const p = parseArgs(args, { limit: 'value', json: 'bool' })
  positionals(p, [])
  const limitFlag = str(p, 'limit')
  const limit = limitFlag === undefined ? 20 : parsePositiveInt(limitFlag, '--limit')
  const entries = await api<AuditEntry[]>('GET', `/api/v1/audit?limit=${limit}`)
  if (bool(p, 'json')) return printJson(entries)
  if (entries.length === 0) return print('No audit entries yet.')
  print(
    renderTable(
      ['TIME', 'SOURCE', 'ACTOR', 'CONNECTION', 'ACCESS', 'OK', 'MS', 'SQL'],
      entries.map((e) => [
        shortTime(e.at),
        e.source,
        e.actor,
        e.connectionName,
        e.access,
        yesNo(e.ok),
        String(e.durationMs),
        e.sql.replace(/\s+/g, ' ').trim(),
      ]),
    ),
  )
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Reads a line from the terminal without echo. Ctrl-C restores the terminal and exits 130. */
function readHidden(label: string): Promise<string> {
  const stdin = process.stdin
  return new Promise((resolve) => {
    process.stdout.write(label)
    let value = ''
    const restore = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onData = (chunk: Buffer | string): void => {
      const text = String(chunk)
      // Arrow keys and other escape sequences start with ESC; ignore them.
      if (text.startsWith('\u001b')) return
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          restore()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          restore()
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          value = Array.from(value).slice(0, -1).join('')
        } else if (ch >= ' ') {
          value += ch
        }
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function cmdResetPassword(args: string[]): Promise<void> {
  const p = parseArgs(args, { 'password-stdin': 'bool' })
  positionals(p, [])
  // Fail early when there is no local key, before asking for a password.
  authHeaders('local')

  let password: string
  if (bool(p, 'password-stdin')) {
    password = stripOneNewline(await Bun.stdin.text())
  } else {
    if (!process.stdin.isTTY) {
      throw new Error('Pass --password-stdin to read the new password from stdin when there is no terminal.')
    }
    password = await readHidden('New password: ')
    const repeat = await readHidden('Repeat password: ')
    if (repeat !== password) throw new Error('The passwords do not match.')
  }

  await api('POST', '/api/auth/reset-password', { body: { password }, auth: 'local' })
  print('Admin password changed. Existing sign-ins are signed out.')
}

// ---------------------------------------------------------------------------
// MCP stdio bridge
// ---------------------------------------------------------------------------

function writeJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

/** The JSON-RPC id of a message, or undefined for notifications and batches. */
function requestId(message: unknown): unknown {
  if (message && typeof message === 'object' && !Array.isArray(message) && 'id' in message) {
    return message.id
  }
  return undefined
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Forwards one JSON-RPC line to /mcp and prints the reply as one line on stdout. */
async function relayMcpLine(line: string, scope: 'read' | 'write'): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    writeJsonLine({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  const id = requestId(message)
  // Only requests (messages with an id) get an error reply on stdout.
  const replyError = (text: string): void => {
    if (id !== undefined) writeJsonLine({ jsonrpc: '2.0', id, error: { code: -32000, message: text } })
  }

  let res: RawResponse
  try {
    res = await rawRequest('POST', '/mcp', { ...authHeaders(), 'X-PowView-Agent-Scope': scope }, line)
  } catch (err) {
    printError(messageOf(err))
    replyError(`Cannot reach PowView at ${serverUrl()}.`)
    return
  }

  if (res.status === 202) return
  if (res.status >= 200 && res.status <= 299) {
    try {
      writeJsonLine(JSON.parse(res.text))
    } catch {
      printError('PowView sent a response that is not JSON.')
      replyError('Invalid response from PowView.')
    }
    return
  }

  if (res.status === 401) printError(SIGN_IN_HINT.join('\n'))
  else printError(`PowView rejected an MCP request: ${errorMessage(res)}`)
  replyError(apiErrorMessage(res.text) ?? `HTTP ${res.status}`)
}

async function cmdMcp(args: string[]): Promise<void> {
  const p = parseArgs(args, { write: 'bool' })
  positionals(p, [])
  const scope = bool(p, 'write') ? 'write' : 'read'
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  // One line at a time, in order: replies keep the order of the requests.
  for await (const line of lines) {
    if (line.trim() === '') continue
    await relayMcpLine(line, scope)
  }
}

// ---------------------------------------------------------------------------
// Help and dispatch
// ---------------------------------------------------------------------------

const USAGE = [
  'powview <command>',
  '',
  'Server',
  '  powview status [--json]',
  '      Show the server URL, whether sign-in is set up, and whether the CLI can connect.',
  '',
  'Connections',
  '  powview conn list [--json]',
  '      List connections with your access to each one.',
  '  powview conn add <url> [--name N] [--read-only] [--production] [--ai off|read|write] [--color C] [--password-stdin] [--json]',
  '      [--ssh user@host[:port] (--ssh-key FILE | --ssh-password-stdin)]',
  '      Add a connection from a PostgreSQL URL. --password-stdin reads the password from stdin.',
  '      --production marks the connection as production: PowView asks before every change in the UI.',
  '      --ssh connects through an SSH server first. --ssh-key reads a private key file,',
  '      --ssh-password-stdin reads the SSH password from stdin.',
  '  powview conn edit <id|name> [--name N] [--url U] [--read-only | --writable] [--production | --not-production] [--ai off|read|write] [--json]',
  '      [--ssh user@host[:port]] [--ssh-key FILE | --ssh-password-stdin] [--no-ssh]',
  '      Change a connection. Only the flags you pass are updated. --no-ssh removes the SSH tunnel.',
  '      Without a new secret, the saved SSH password or key is kept.',
  '  powview conn remove <id|name> [--yes]',
  '      Remove a connection. Asks first unless --yes is given.',
  '  powview conn test <id|name>',
  '      Check that PowView can reach the database.',
  '',
  'Schema and queries',
  '  powview tables <conn> [--schema S] [--json]',
  '      List tables, views and other relations.',
  '  powview describe <conn> <table> [--schema S] [--json]',
  '      Show the columns, keys and indexes of a table. Accepts schema.table.',
  '  powview query <conn> "<sql>" [--write] [--json] [--max-rows N]',
  '      Run SQL. Read-only unless --write is given.',
  '',
  'Export (local key: run where POWVIEW_DATA_DIR points at the data folder, or docker exec)',
  '  powview export <conn> <table> [--schema S] [--format csv|json|ndjson|sql] [--where "<sql condition>"] [--output FILE]',
  '      Export a whole table, or only the rows matching --where, streamed to a file. Default: <table>.<format>.',
  '      --output - writes to stdout. Accepts schema.table.',
  '  powview dump <conn> [--database D] [--content all|schema|data] [--format sql|sql-gz|custom] [--schema S]... [--table schema.table]... [--output FILE]',
  '      Dump a database with pg_dump. Default: <database>-<YYYYMMDD-HHmm>.sql (.sql.gz for sql-gz, .dump for custom).',
  '      --schema and --table repeat; choose one or the other. Needs pg_dump on the server.',
  '      Inside Docker, write to stdout and redirect: docker exec powview powview dump shop --output - > shop.sql',
  '  powview restore <conn> <file> [--database D] [--keep-going] [--clean]',
  '      Run a .sql, .sql.gz or pg_dump custom (.dump) file into a database. The format is read from the file.',
  '      All or nothing by default: an error stops the run and undoes it. --keep-going keeps what ran and exits 1 when it counted errors.',
  '      --clean drops existing objects first (custom files only). Restore into an empty database unless the file replaces what is there.',
  '      Needs psql and pg_restore on the server. Inside Docker, copy the file in first: docker cp shop.sql powview:/tmp/shop.sql',
  '      then docker exec powview powview restore shop /tmp/shop.sql',
  '',
  'API tokens',
  '  powview token create <name> [--scope read|write|admin] [--conn id,id] [--expires 30d|90d|1y|never|<n>d] [--json]',
  '      Create an API token. It expires after 90 days unless --expires says otherwise.',
  '      The token is shown only once.',
  '  powview token list [--json]',
  '      List API tokens. Secrets are never shown.',
  '  powview token revoke <id>',
  '      Revoke an API token.',
  '',
  'Audit and admin',
  '  powview audit [--limit N] [--json]',
  '      Show recent queries and who ran them.',
  '  powview admin reset-password [--password-stdin]',
  '      Set a new admin password. Needs the local key, so run it where POWVIEW_DATA_DIR points at the data folder.',
  '',
  'AI agents',
  '  powview mcp [--write]',
  '      Run the stdio MCP bridge for AI agents such as Claude Code or Cursor.',
  '  powview help',
  '      Show this help.',
  '',
  'Environment',
  '  POWVIEW_URL       Server URL (default http://127.0.0.1:3333)',
  '  POWVIEW_TOKEN     API token to use instead of the local key',
  '  POWVIEW_DATA_DIR  PowView data folder that holds auth.json (default ./.data)',
]

function reportUnknown(name: string): void {
  printError(`Unknown command: ${name}.`)
  USAGE.forEach((line) => printError(line))
  process.exitCode = 1
}

async function run(argv: string[]): Promise<void> {
  const command = argv[0]
  const sub = argv[1]
  if (command === undefined || command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    USAGE.forEach((line) => print(line))
    return
  }
  const afterCommand = argv.slice(1)
  const afterSub = argv.slice(2)

  switch (command) {
    case 'status':
      return cmdStatus(afterCommand)
    case 'tables':
      return cmdTables(afterCommand)
    case 'describe':
      return cmdDescribe(afterCommand)
    case 'query':
      return cmdQuery(afterCommand)
    case 'export':
      return cmdExport(afterCommand)
    case 'dump':
      return cmdDump(afterCommand)
    case 'restore':
      return cmdRestore(afterCommand)
    case 'audit':
      return cmdAudit(afterCommand)
    case 'mcp':
      return cmdMcp(afterCommand)
    case 'conn':
      switch (sub) {
        case 'list':
          return cmdConnList(afterSub)
        case 'add':
          return cmdConnAdd(afterSub)
        case 'edit':
          return cmdConnEdit(afterSub)
        case 'remove':
          return cmdConnRemove(afterSub)
        case 'test':
          return cmdConnTest(afterSub)
        default:
          return reportUnknown(`conn ${sub ?? ''}`.trim())
      }
    case 'token':
      switch (sub) {
        case 'create':
          return cmdTokenCreate(afterSub)
        case 'list':
          return cmdTokenList(afterSub)
        case 'revoke':
          return cmdTokenRevoke(afterSub)
        default:
          return reportUnknown(`token ${sub ?? ''}`.trim())
      }
    case 'admin':
      if (sub === 'reset-password') return cmdResetPassword(afterSub)
      return reportUnknown(`admin ${sub ?? ''}`.trim())
    default:
      return reportUnknown(command)
  }
}

/**
 * The server writes auth.json (with the local key) on its first request. Right after a fresh
 * start nothing has asked yet, so ask once before giving up on the local key.
 */
async function ensureLocalKey(): Promise<void> {
  if (process.env.POWVIEW_TOKEN || readLocalKey()) return
  try {
    await fetch(`${serverUrl()}/api/auth/state`, { signal: AbortSignal.timeout(3000) })
  } catch {
    // Server not reachable: the command reports that itself.
  }
}

async function main(): Promise<void> {
  try {
    await ensureLocalKey()
    await run(process.argv.slice(2))
  } catch (err) {
    printError(messageOf(err))
    process.exitCode = 1
  }
}

main()
