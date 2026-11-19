import type pg from 'pg'
import { csvEscape, jsonValue, sqlValue, uniqueNames, type ExportField } from '@/lib/export'
import { cellToText } from '@/lib/format'
import { describeError } from '@/lib/redact'
import { s, type Schema } from '@/lib/schema'
import { displayIdent, qualifiedName } from '@/lib/sql'
import { TABLE_EXPORT_FORMATS, type TableExportFormat } from '@/lib/table-export'
import { FILTER_OPERATORS, type Cell, type ConnectionConfig } from '@/lib/types'
import { authenticate } from '@/server/access.server'
import { readInBatches, type CursorBatch } from '@/server/cursor.server'
import { findConnection } from '@/server/http/core.server'
import { HttpError, errorResponse, errorToResponse, guardOrigin, queryParam } from '@/server/http/util.server'
import {
  InvalidViewError,
  RelationNotFound,
  buildViewQuery,
  describeFields,
  relationShape,
  type TableView,
} from './data.server'
import { isPgError, poolFor, rawTypes, toError } from './pool.server'

/**
 * Whole-table export for the signed-in user (session cookie or local key). The rows are
 * read with a cursor in batches and written to the response as they come, so the table
 * is never held in memory. The SQL is the grid's own (filters, WHERE, search, sort).
 */

const EXPORT_BATCH_ROWS = 1000

interface TableExportRequest {
  connection: string
  database?: string
  schema: string
  table: string
  format: TableExportFormat
  view: TableView
}

// ---------------------------------------------------------------------------
// Row encoders (pure; the stream calls them once per batch)
// ---------------------------------------------------------------------------

/** What an encoder needs to know about the export. `table` is the qualified SQL name. */
export interface ExportTarget {
  table: string
  fields: ExportField[]
}

interface Encoder {
  contentType: string
  ext: string
  /** Written once, before the first batch. */
  head(target: ExportTarget): string
  /** One batch of rows; `offset` is how many rows came before it. */
  rows(target: ExportTarget, rows: Cell[][], offset: number): string
  /** Written once, after the last batch. `count` is the total number of rows. */
  foot(count: number): string
}

const CSV_EOL = '\r\n'

/** A JSON object for one row. A null prototype keeps a column named "__proto__" an ordinary key. */
export function rowObject(names: string[], fields: ExportField[], row: Cell[]): Record<string, unknown> {
  const obj: Record<string, unknown> = Object.create(null)
  names.forEach((name, i) => {
    obj[name] = jsonValue(row[i] ?? null, fields[i]!.kind)
  })
  return obj
}

export const encoders: Record<TableExportFormat, Encoder> = {
  csv: {
    contentType: 'text/csv; charset=utf-8',
    ext: 'csv',
    head: ({ fields }) => fields.map((f) => csvEscape(f.name)).join(',') + CSV_EOL,
    rows: (_target, rows) => rows.map((r) => r.map((v) => csvEscape(cellToText(v))).join(',') + CSV_EOL).join(''),
    foot: () => '',
  },
  json: {
    contentType: 'application/json',
    ext: 'json',
    head: () => '[',
    rows: ({ fields }, rows, offset) => {
      const names = uniqueNames(fields)
      return rows.map((r, i) => `${offset + i > 0 ? ',' : ''}\n${JSON.stringify(rowObject(names, fields, r))}`).join('')
    },
    foot: () => '\n]\n',
  },
  ndjson: {
    contentType: 'application/x-ndjson',
    ext: 'ndjson',
    head: () => '',
    rows: ({ fields }, rows) => {
      const names = uniqueNames(fields)
      return rows.map((r) => `${JSON.stringify(rowObject(names, fields, r))}\n`).join('')
    },
    foot: () => '',
  },
  sql: {
    contentType: 'application/sql',
    ext: 'sql',
    head: () => '',
    rows: ({ table, fields }, rows) => {
      const cols = fields.map((f) => displayIdent(f.name)).join(', ')
      return rows
        .map(
          (r) =>
            `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => sqlValue(v, fields[i]!.kind)).join(', ')});\n`,
        )
        .join('')
    },
    foot: (count) => (count === 0 ? '-- no rows\n' : ''),
  },
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

const MAX_WHERE_CHARS = 10_000
const MAX_SEARCH_CHARS = 1_000

const filterSchema = s.object({
  column: s.string(),
  op: s.enum(FILTER_OPERATORS),
  value: s.string().optional(),
})
const sortSchema = s.object({ column: s.string(), direction: s.enum(['asc', 'desc']) })

function jsonParam<O>(request: Request, name: string, schema: Schema<O, unknown>): O | undefined {
  const raw = queryParam(request, name)
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'invalid_request', `${name} is not valid JSON.`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HttpError(400, 'invalid_request', `${name}: ${issue?.message ?? 'not valid'}`)
  }
  return parsed.data
}

/** Query string → export request. Anything wrong with it is a 400 before the database is touched. */
export function parseTableExportRequest(request: Request): TableExportRequest {
  const required = (name: string) => {
    const value = queryParam(request, name)
    if (value === undefined) throw new HttpError(400, 'invalid_request', `${name} is required.`)
    return value
  }
  const format = required('format')
  if (!(TABLE_EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new HttpError(400, 'invalid_request', 'format must be csv, json, ndjson or sql.')
  }
  const where = queryParam(request, 'where')
  const search = queryParam(request, 'q')
  if (where && where.length > MAX_WHERE_CHARS) {
    throw new HttpError(400, 'invalid_request', `where is longer than ${MAX_WHERE_CHARS} characters.`)
  }
  if (search && search.length > MAX_SEARCH_CHARS) {
    throw new HttpError(400, 'invalid_request', `q is longer than ${MAX_SEARCH_CHARS} characters.`)
  }
  return {
    connection: required('connection'),
    database: queryParam(request, 'database'),
    schema: required('schema'),
    table: required('table'),
    format: format as TableExportFormat,
    view: {
      filters: jsonParam(request, 'filters', s.array(filterSchema).max(100)) ?? [],
      sort: jsonParam(request, 'sort', s.array(sortSchema).max(20)) ?? [],
      where,
      search,
    },
  }
}

/** A file name from the table name: no path separators, quotes or other odd characters. */
export function exportFileName(table: string, ext: string): string {
  const base = table
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return `${base || 'export'}.${ext}`
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

const encodeText = (text: string) => new TextEncoder().encode(text)

/** The next page of rows. An empty page means the export is finished. */
async function nextRows(batches: AsyncGenerator<CursorBatch>): Promise<Cell[][]> {
  const step = await batches.next()
  return step.done ? [] : (step.value.rows as Cell[][])
}

/** pg errors from the user's SQL (a bad WHERE clause, say) are the caller's problem. */
function queryFailed(err: unknown): unknown {
  if (isPgError(err)) return new HttpError(400, 'query_failed', toError(err).message)
  return err
}

async function streamTable(conn: ConnectionConfig, req: TableExportRequest): Promise<Response> {
  const database = req.database || conn.database
  const { pool } = await poolFor(conn.id, database)
  const client = await pool.connect()
  let batches: AsyncGenerator<CursorBatch> | undefined
  let open = true
  let cancelled = false

  // Normal end: roll back and give the connection back to the pool. Anything else (error,
  // client gone) destroys it. A half-read cursor cannot be closed safely over a dead socket.
  const finish = async (clean: boolean) => {
    if (!open) return
    open = false
    let reusable = clean
    if (reusable) {
      try {
        await batches?.return(undefined)
        await client.query('ROLLBACK')
      } catch {
        reusable = false
      }
    }
    client.release(reusable ? undefined : true)
  }

  let first: Cell[][]
  let target: ExportTarget
  try {
    // One read-only transaction for the whole export. No statement timeout: a big table may take a while.
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL statement_timeout = 0')
    const shape = await relationShape(client, req.schema, req.table)
    const view = buildViewQuery(req.schema, req.table, shape, req.view)
    // LIMIT 0 plans the query and reports its columns (types included) without reading a row.
    const probe = await client.query({
      text: `${view.text} LIMIT 0`,
      values: view.values,
      queryMode: 'extended',
    } as pg.QueryConfig)
    const fields = await describeFields(client, `${conn.id}::${database}`, probe.fields)
    target = {
      table: qualifiedName(req.schema, req.table),
      fields: fields.map((f) => ({ name: f.name, kind: f.kind })),
    }
    batches = readInBatches(client, view.text, view.values, EXPORT_BATCH_ROWS, {
      rowMode: 'array',
      types: rawTypes,
      inTransaction: true,
    })
    // The first batch is read before the response starts, so a bad query still gets a proper status.
    first = await nextRows(batches)
  } catch (err) {
    await finish(false)
    throw queryFailed(err)
  }

  const enc = encoders[req.format]
  let pending: Cell[][] | null = first
  let headSent = false
  let written = 0

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (!headSent) {
            headSent = true
            controller.enqueue(encodeText(enc.head(target)))
          }
          const rows = pending ?? (await nextRows(batches!))
          pending = null
          if (rows.length === 0) {
            controller.enqueue(encodeText(enc.foot(written)))
            await finish(true)
            controller.close()
            return
          }
          controller.enqueue(encodeText(enc.rows(target, rows, written)))
          written += rows.length
        } catch (err) {
          // Once the status line is out, the only way to report an error is to end the body early.
          if (!cancelled)
            console.error(
              `[powdb] export of ${req.schema}.${req.table} failed after ${written} rows: ${describeError(err)}`,
            )
          await finish(false)
          controller.error(err)
        }
      },
      async cancel() {
        // The browser went away (closed the download, lost the network): stop reading and free the connection.
        cancelled = true
        await finish(false)
      },
    },
    { highWaterMark: 0 },
  )

  return new Response(body, {
    headers: {
      'Content-Type': enc.contentType,
      'Content-Disposition': `attachment; filename="${exportFileName(req.table, enc.ext)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/** GET /api/export/table. Signed-in users and the local key only; API tokens and agents get 403. */
export async function handleExportRequest(request: Request): Promise<Response> {
  try {
    guardOrigin(request)
    const principal = await authenticate(request)
    if (!principal) {
      return errorResponse(401, 'unauthenticated', 'Sign in, or send the local key.')
    }
    if (principal.kind !== 'user') {
      throw new HttpError(
        403,
        'forbidden',
        'API tokens and AI agents cannot export whole tables. Sign in to PowDB, or use the local key.',
      )
    }
    const req = parseTableExportRequest(request)
    const conn = await findConnection(principal, req.connection)
    return await streamTable(conn, req)
  } catch (err) {
    if (err instanceof RelationNotFound) return errorResponse(404, 'not_found', err.message)
    if (err instanceof InvalidViewError) return errorResponse(400, 'invalid_request', err.message)
    return errorToResponse(err)
  }
}
