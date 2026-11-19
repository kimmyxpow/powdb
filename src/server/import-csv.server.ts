import type pg from 'pg'
import { CsvStream, detectDelimiter } from '@/lib/csv'
import { s } from '@/lib/schema'
import { qualifiedName, quoteIdent } from '@/lib/sql'
import { checkOrigin, loadConnection, requireUser } from './dump.server'
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
import { poolFor, toError } from './pool.server'

/**
 * CSV import into an existing table. The raw file is the request body and everything else
 * is in the query string. Every row goes in one transaction: if any batch fails, the whole
 * file is rolled back, and so is an upload the client abandons.
 */

const DEFAULT_MAX_IMPORT_MB = 200
const MIB = 1024 * 1024
const BATCH_ROWS = 500
/** PostgreSQL allows 65535 bind parameters per statement; stay well below that. */
const MAX_PARAMS = 60_000
/** Text held back until the delimiter can be detected from the first line. */
const SNIFF_CHARS = 64 * 1024

interface ImportMapping {
  column: string
  /** 0-based index of the CSV column */
  source: number
}

interface ImportRequest {
  connection: string
  database: string
  schema: string
  table: string
  header: boolean
  nullEmpty: boolean
  /** undefined: detect from the first line */
  delimiter?: string
  mapping: ImportMapping[]
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

const noNul = (value: string) => !value.includes('\0')

const MappingSchema = s
  .array(
    s.object({
      column: s.string().min(1).max(255).refine(noNul, 'Column names cannot contain NUL characters.'),
      source: s.number().int().min(0).max(100_000),
    }),
  )
  .min(1, 'Map at least one column.')
  .max(1600)

/** A required name, kept exactly as given (names may contain spaces). */
function nameParam(params: URLSearchParams, name: string, max: number): string {
  const value = params.get(name) ?? ''
  if (value === '') throw badRequest(`${name} is required.`)
  if (value.length > max || !noNul(value)) throw badRequest(`${name} is not a valid name.`)
  return value
}

function delimiterParam(params: URLSearchParams): string | undefined {
  const value = params.get('delimiter')
  if (value === null || value === '') return undefined
  if (value.length !== 1 || value === '"' || value === '\r' || value === '\n') {
    throw badRequest('delimiter must be one character, and not a quote or a line break.')
  }
  return value
}

function mappingParam(params: URLSearchParams): ImportMapping[] {
  const raw = params.get('mapping')
  if (raw === null) throw badRequest('mapping is required.')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw badRequest('mapping must be a JSON array of {column, source}.')
  }
  const parsed = MappingSchema.safeParse(json)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'mapping is not valid.')
  return parsed.data
}

export function parseImportParams(params: URLSearchParams): ImportRequest {
  return {
    connection: nameParam(params, 'connection', 200),
    database: nameParam(params, 'database', 255),
    schema: nameParam(params, 'schema', 255),
    table: nameParam(params, 'table', 255),
    header: flagParam(params, 'header'),
    nullEmpty: flagParam(params, 'nullEmpty'),
    delimiter: delimiterParam(params),
    mapping: mappingParam(params),
  }
}

// ---------------------------------------------------------------------------
// Table and mapping
// ---------------------------------------------------------------------------

interface TableColumn {
  name: string
  notNull: boolean
  hasDefault: boolean
  /** '' | 'a' (always) | 'd' (by default) */
  identity: string
  /** '' | 's' (stored) */
  generated: string
}

/** The table's columns from the catalog. 404 when the table is missing, 400 when it is not an ordinary table. */
async function loadTableColumns(pool: pg.Pool, schema: string, table: string): Promise<TableColumn[]> {
  let result: pg.QueryResult<{
    name: string
    not_null: boolean
    has_default: boolean
    identity: string
    generated: string
    relkind: string
  }>
  try {
    result = await pool.query(
      `SELECT a.attname AS name,
              a.attnotnull AS not_null,
              a.atthasdef AS has_default,
              a.attidentity::text AS identity,
              a.attgenerated::text AS generated,
              c.relkind::text AS relkind
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.oid = to_regclass($1)
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [qualifiedName(schema, table)],
    )
  } catch (err) {
    throw toError(err)
  }
  if (result.rows.length === 0)
    throw new HttpError(404, 'not_found', 'Table not found. It may have been renamed or dropped.')
  if (!['r', 'p'].includes(result.rows[0]!.relkind)) {
    throw badRequest('Rows can only be imported into a table, not a view.')
  }
  return result.rows.map((r) => ({
    name: r.name,
    notNull: r.not_null,
    hasDefault: r.has_default,
    identity: r.identity,
    generated: r.generated,
  }))
}

interface ColumnPlan {
  /** target column names, in mapping order */
  names: string[]
  /** CSV column index for each target */
  sources: number[]
}

/** Checks the mapping against the table: known columns, no duplicates, nothing generated, nothing required left out. */
function planMapping(columns: TableColumn[], mapping: ImportMapping[]): ColumnPlan {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const mapped = new Set<string>()
  for (const item of mapping) {
    const column = byName.get(item.column)
    if (!column) throw badRequest(`Unknown column "${item.column}".`)
    if (mapped.has(item.column)) throw badRequest(`Column "${item.column}" is mapped more than once.`)
    if (column.identity === 'a' || column.generated !== '') {
      throw badRequest(`"${item.column}" is generated by the database and cannot be imported.`)
    }
    mapped.add(item.column)
  }
  const missing = columns.find(
    (c) => c.notNull && !c.hasDefault && c.identity === '' && c.generated === '' && !mapped.has(c.name),
  )
  if (missing) throw badRequest(`${missing.name} is required and has no default.`)
  return { names: mapping.map((m) => m.column), sources: mapping.map((m) => m.source) }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Reads the body, parses it and inserts it in batches inside one transaction. Returns the
 * number of rows inserted. Any error (including a client that disconnects) rolls back.
 */
async function importRows(
  pool: pg.Pool,
  request: Request,
  req: ImportRequest,
  plan: ColumnPlan,
  limitMb: number,
): Promise<number> {
  const body = request.body
  if (!body) throw badRequest('The request has no file.')
  const limitBytes = limitMb * MIB
  const batchRows = Math.max(1, Math.min(BATCH_ROWS, Math.floor(MAX_PARAMS / plan.sources.length)))
  const target = qualifiedName(req.schema, req.table)
  const columnList = plan.names.map(quoteIdent).join(', ')

  // The reader is taken before the client is checked out, so a failure here cannot leak one.
  const reader = body.getReader()
  let client: pg.PoolClient
  try {
    client = await pool.connect()
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw toError(err)
  }
  const onAbort = () => void reader.cancel().catch(() => {})
  request.signal.addEventListener('abort', onAbort, { once: true })
  const aborted = () => new HttpError(400, 'aborted', 'The upload was cancelled.')

  let broken: Error | undefined
  let inserted = 0
  let pending: { line: number; cells: string[] }[] = []
  let skipHeader = req.header
  let stream: CsvStream | null = null
  let head = ''
  let bytesSeen = 0
  // TextDecoder drops a UTF-8 BOM by default
  const decoder = new TextDecoder('utf-8')

  const flush = async () => {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    const params: (string | null)[] = []
    const groups: string[] = []
    for (const { cells } of batch) {
      const marks: string[] = []
      for (const source of plan.sources) {
        const value = cells[source] ?? ''
        params.push(req.nullEmpty && value === '' ? null : value)
        marks.push(`$${params.length}`)
      }
      groups.push(`(${marks.join(', ')})`)
    }
    try {
      await client.query(`INSERT INTO ${target} (${columnList}) VALUES ${groups.join(', ')}`, params)
    } catch (err) {
      const first = batch[0]!.line
      const last = batch[batch.length - 1]!.line
      const where = first === last ? `Line ${first}` : `Lines ${first}-${last}`
      throw new HttpError(422, 'import_failed', `${where}: ${toError(err).message}`)
    }
    inserted += batch.length
  }

  const ingest = async (rows: string[][], lines: number[]) => {
    for (let i = 0; i < rows.length; i++) {
      if (skipHeader) {
        skipHeader = false
        continue
      }
      pending.push({ line: lines[i] ?? 0, cells: rows[i]! })
      if (pending.length >= batchRows) await flush()
    }
  }

  const feed = async (chunk: string, last: boolean) => {
    let text = chunk
    if (!stream) {
      // hold text until the delimiter can be detected from the first line
      head += chunk
      if (!last && head.length < SNIFF_CHARS && !/[\r\n]/.test(head)) return
      stream = new CsvStream(req.delimiter ?? detectDelimiter(head))
      text = head
      head = ''
    }
    await ingest(stream.push(text), stream.lastLines)
    if (last) await ingest(stream.end(), stream.lastLines)
  }

  try {
    await client.query('BEGIN')
    for (;;) {
      const { done, value } = await reader.read()
      if (request.signal.aborted) throw aborted()
      if (done) break
      bytesSeen += value.byteLength
      if (bytesSeen > limitBytes) throw fileTooLarge(limitMb, 'POWDBS_MAX_IMPORT_MB')
      await feed(decoder.decode(value, { stream: true }), false)
    }
    await feed(decoder.decode(), true)
    await flush()
    if (request.signal.aborted) throw aborted()
    if (inserted === 0) throw badRequest('The file has no data rows.')
    await client.query('COMMIT')
    return inserted
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      broken = toError(rollbackErr)
    })
    throw err
  } finally {
    request.signal.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
    client.release(broken)
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** POST /api/import/csv: the query string says where the rows go, the body is the CSV file. */
export async function handleCsvImport(request: Request): Promise<Response> {
  try {
    await requireUser(request, 'import CSV', 'CSV import is for signed-in users only. API tokens cannot import.')
    checkOrigin(request)
    const req = parseImportParams(new URL(request.url).searchParams)
    const conn = await loadConnection(req.connection)
    if (conn.readOnly) throw new HttpError(403, 'read_only', 'This connection is read-only.')
    const limitMb = envMegabytes('POWDBS_MAX_IMPORT_MB', DEFAULT_MAX_IMPORT_MB)
    checkDeclaredSize(request, limitMb, 'POWDBS_MAX_IMPORT_MB')
    const { pool } = await poolFor(conn.id, req.database)
    const columns = await loadTableColumns(pool, req.schema, req.table)
    const plan = planMapping(columns, req.mapping)
    const inserted = await importRows(pool, request, req, plan, limitMb)
    return jsonResponse({ inserted }, 200, { 'Cache-Control': 'no-store' })
  } catch (err) {
    return errorToResponse(err)
  }
}
