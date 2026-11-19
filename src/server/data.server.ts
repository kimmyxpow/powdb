import type pg from 'pg'
import { builtinType, kindFromPgType } from '@/lib/pg-types'
import { qualifiedName, quoteIdent } from '@/lib/sql'
import type {
  ApplyChangesResult,
  Cell,
  CountResult,
  EditValue,
  Filter,
  ResultField,
  RowChanges,
  RowKey,
  RowsRequest,
  ReferenceLookup,
  RowsResult,
  Sort,
} from '@/lib/types'
import { firstKeyword, readStatementRows } from './cursor.server'
import { isPgError, pgErrorInfo, poolFor, rawTypes, toError } from './pool.server'

// ---------------------------------------------------------------------------
// Result field types
// ---------------------------------------------------------------------------

const typeCache = new Map<string, Map<number, { name: string; kind: ResultField['kind'] }>>()

/** Resolve type names for result fields (built-ins locally, others via pg_type). */
export async function describeFields(
  client: pg.PoolClient,
  cacheKey: string,
  fields: pg.FieldDef[],
): Promise<ResultField[]> {
  let cache = typeCache.get(cacheKey)
  if (!cache) {
    cache = new Map()
    typeCache.set(cacheKey, cache)
  }
  const unknown = [...new Set(fields.map((f) => f.dataTypeID).filter((oid) => !builtinType(oid) && !cache!.has(oid)))]
  if (unknown.length) {
    try {
      const res = await client.query<{ oid: number; typname: string; typcategory: string; typtype: string }>(
        `SELECT oid::int AS oid, typname, typcategory::text AS typcategory, typtype::text AS typtype
           FROM pg_type WHERE oid = ANY($1::oid[])`,
        [unknown],
      )
      for (const r of res.rows) {
        const name = r.typname.startsWith('_') ? `${r.typname.slice(1)}[]` : r.typname
        cache.set(r.oid, { name, kind: kindFromPgType(r.typname, r.typcategory, r.typtype) })
      }
    } catch {
      // aborted transactions etc.: fall back to "other"
    }
  }
  return fields.map((f) => {
    const t = builtinType(f.dataTypeID) ?? cache!.get(f.dataTypeID)
    return {
      name: f.name,
      typeOid: f.dataTypeID,
      typeName: t?.name ?? String(f.dataTypeID),
      kind: t?.kind ?? 'other',
    }
  })
}

/**
 * One statement of a SQL editor run or an agent query, read with at most `maxRows` rows (the
 * caller passes the cap, and this helper reads one more to see whether it was cut short).
 * `cacheKey` names the connection and database for the result type cache.
 */
export interface StatementOutput {
  rows: unknown[][]
  fields: ResultField[]
  command: string | null
  rowCount: number | null
  truncated: boolean
}

export async function readStatement(
  client: pg.PoolClient,
  text: string,
  maxRows: number,
  cacheKey: string,
  inTransaction: boolean,
): Promise<StatementOutput> {
  // One row past the cap tells us whether the result was cut short.
  const {
    rows,
    fields: rawFields,
    command,
    rowCount,
  } = await readStatementRows(client, text, maxRows + 1, { types: rawTypes, inTransaction })
  const truncated = rows.length > maxRows
  const fields = rawFields.length ? await describeFields(client, cacheKey, rawFields) : []
  return {
    rows: truncated ? rows.slice(0, maxRows) : rows,
    fields,
    command: command ?? firstKeyword(text)?.toUpperCase() ?? null,
    rowCount: truncated ? null : (rowCount ?? (fields.length ? rows.length : null)),
    truncated,
  }
}

// ---------------------------------------------------------------------------
// WHERE clause builder
// ---------------------------------------------------------------------------

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

function buildWhere(
  filters: Filter[],
  where: string | undefined,
  search: string | undefined,
  searchColumns: string[],
  values: unknown[],
): string {
  const parts: string[] = []
  const param = (v: unknown) => {
    values.push(v)
    return `$${values.length}`
  }
  for (const f of filters) {
    const col = quoteIdent(f.column)
    const v = f.value ?? ''
    switch (f.op) {
      case 'eq':
        parts.push(`${col} = ${param(v)}`)
        break
      case 'neq':
        parts.push(`${col} IS DISTINCT FROM ${param(v)}`)
        break
      case 'gt':
        parts.push(`${col} > ${param(v)}`)
        break
      case 'gte':
        parts.push(`${col} >= ${param(v)}`)
        break
      case 'lt':
        parts.push(`${col} < ${param(v)}`)
        break
      case 'lte':
        parts.push(`${col} <= ${param(v)}`)
        break
      case 'contains':
        parts.push(`${col}::text ILIKE ${param(`%${escapeLike(v)}%`)}`)
        break
      case 'not_contains':
        parts.push(`${col}::text NOT ILIKE ${param(`%${escapeLike(v)}%`)}`)
        break
      case 'starts_with':
        parts.push(`${col}::text ILIKE ${param(`${escapeLike(v)}%`)}`)
        break
      case 'ends_with':
        parts.push(`${col}::text ILIKE ${param(`%${escapeLike(v)}`)}`)
        break
      case 'in': {
        const list = v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        parts.push(list.length ? `${col}::text = ANY(${param(list)}::text[])` : 'false')
        break
      }
      case 'is_null':
        parts.push(`${col} IS NULL`)
        break
      case 'not_null':
        parts.push(`${col} IS NOT NULL`)
        break
    }
  }
  if (where?.trim()) parts.push(`(${where.trim()})`)
  if (search?.trim() && searchColumns.length) {
    const p = param(`%${escapeLike(search.trim())}%`)
    parts.push(`(${searchColumns.map((c) => `${quoteIdent(c)}::text ILIKE ${p}`).join(' OR ')})`)
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
}

export interface RelationShape {
  kind: string
  columns: string[]
  primaryKey: string[]
  estimatedRows: number | null
}

/** The table or view does not exist (or is not visible to this connection). */
export class RelationNotFound extends Error {}

/** A filter, sort or search names a column the relation does not have. */
export class InvalidViewError extends Error {}

export async function relationShape(client: pg.PoolClient, schema: string, table: string): Promise<RelationShape> {
  const res = await client.query<{
    kind: string
    columns: string[] | null
    pk: string[] | null
    estimated: number | null
  }>(
    `SELECT c.relkind::text AS kind,
            (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM pg_constraint con
               CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
              WHERE con.conrelid = c.oid AND con.contype = 'p') AS pk,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS estimated
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  )
  const row = res.rows[0]
  if (!row) throw new RelationNotFound(`Relation ${schema}.${table} does not exist`)
  return {
    kind: row.kind,
    columns: row.columns ?? [],
    primaryKey: row.pk ?? [],
    estimatedRows: row.estimated,
  }
}

function checkColumns(shape: RelationShape, names: string[]) {
  for (const name of names) {
    if (!shape.columns.includes(name)) throw new InvalidViewError(`Unknown column "${name}"`)
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface TableView {
  filters: Filter[]
  where?: string
  search?: string
  sort: Sort[]
}

/** Tables without a primary key are addressed by ctid (their physical row id). */
export function usesCtid(shape: RelationShape): boolean {
  return shape.kind === 'r' && shape.primaryKey.length === 0
}

function buildOrder(sort: Sort[], shape: RelationShape): string {
  if (sort.length) {
    return ` ORDER BY ${sort
      .map((s) => `${quoteIdent(s.column)} ${s.direction === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`)
      .join(', ')}`
  }
  if (shape.primaryKey.length && (shape.kind === 'r' || shape.kind === 'p')) {
    return ` ORDER BY ${shape.primaryKey.map(quoteIdent).join(', ')}`
  }
  if (usesCtid(shape)) return ' ORDER BY ctid'
  return ''
}

/**
 * The SELECT behind a table view, without paging. The grid adds LIMIT/OFFSET; the export
 * streams the whole result. Both go through here, so they filter and sort the same way.
 */
export function buildViewQuery(
  schema: string,
  table: string,
  shape: RelationShape,
  view: TableView,
  opts: { withCtid?: boolean } = {},
): { text: string; values: unknown[] } {
  checkColumns(shape, [...view.sort.map((s) => s.column), ...view.filters.map((f) => f.column)])
  const values: unknown[] = []
  const where = buildWhere(view.filters, view.where, view.search, shape.columns, values)
  const select = opts.withCtid ? '*, ctid' : '*'
  return {
    text: `SELECT ${select} FROM ${qualifiedName(schema, table)}${where}${buildOrder(view.sort, shape)}`,
    values,
  }
}

export async function fetchRows(connectionId: string, database: string, req: RowsRequest): Promise<RowsResult> {
  const { pool } = await poolFor(connectionId, database)
  const client = await pool.connect()
  let broken = false
  try {
    const shape = await relationShape(client, req.schema, req.table)
    const useCtid = usesCtid(shape)
    const view = buildViewQuery(req.schema, req.table, shape, req, { withCtid: useCtid })
    const values = view.values

    const pageSize = Math.min(Math.max(req.pageSize, 1), 5000)
    const offset = Math.max(req.page - 1, 0) * pageSize
    const sql = `${view.text} LIMIT ${pageSize + 1} OFFSET ${offset}`

    const started = performance.now()
    const result = await client.query({
      text: sql,
      values,
      rowMode: 'array',
      types: rawTypes,
      queryMode: 'extended',
    } as pg.QueryConfig)
    const durationMs = Math.round(performance.now() - started)

    let fields = result.fields
    let rows = result.rows as unknown as Cell[][]
    let ctids: string[] | null = null
    if (useCtid) {
      fields = fields.slice(0, -1)
      ctids = rows.map((r) => r[r.length - 1] as string)
      rows = rows.map((r) => r.slice(0, -1))
    }
    const hasMore = rows.length > pageSize
    if (hasMore) {
      rows = rows.slice(0, pageSize)
      ctids = ctids?.slice(0, pageSize) ?? null
    }
    return {
      fields: await describeFields(client, `${connectionId}::${database}`, fields),
      rows,
      ctids,
      hasMore,
      durationMs,
      sql,
    }
  } catch (err) {
    // A network error leaves the connection unusable; a server error does not.
    broken = !isPgError(err)
    throw toError(err)
  } finally {
    client.release(broken)
  }
}

export async function countRows(
  connectionId: string,
  database: string,
  req: Pick<RowsRequest, 'schema' | 'table' | 'filters' | 'where' | 'search'>,
): Promise<CountResult> {
  const { pool } = await poolFor(connectionId, database)
  const client = await pool.connect()
  let broken = false
  try {
    const shape = await relationShape(client, req.schema, req.table)
    checkColumns(
      shape,
      req.filters.map((f) => f.column),
    )
    const filtered = req.filters.length > 0 || Boolean(req.where?.trim()) || Boolean(req.search?.trim())
    if (!filtered && shape.estimatedRows != null && shape.estimatedRows > 2_000_000) {
      return { count: Math.round(shape.estimatedRows), exact: false }
    }
    const values: unknown[] = []
    const where = buildWhere(req.filters, req.where, req.search, shape.columns, values)
    await client.query('BEGIN READ ONLY')
    try {
      await client.query(`SET LOCAL statement_timeout = '4s'`)
      const res = await client.query<{ count: string }>({
        text: `SELECT count(*) AS count FROM ${qualifiedName(req.schema, req.table)}${where}`,
        values,
        queryMode: 'extended',
      } as pg.QueryConfig)
      await client.query('COMMIT')
      return { count: Number(res.rows[0]!.count), exact: true }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      // statement timeout → estimate
      if ((err as { code?: string }).code === '57014') {
        return {
          count: filtered || shape.estimatedRows == null ? null : Math.round(shape.estimatedRows),
          exact: false,
        }
      }
      throw err
    }
  } catch (err) {
    broken = !isPgError(err)
    throw toError(err)
  } finally {
    client.release(broken)
  }
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function keyCondition(key: RowKey, values: unknown[], useCtid: boolean): string {
  if (useCtid) {
    values.push(key.ctid)
    return `ctid = $${values.length}::tid`
  }
  return Object.entries(key)
    .map(([col, v]) => {
      if (v === null) return `${quoteIdent(col)} IS NULL`
      values.push(v)
      return `${quoteIdent(col)} = $${values.length}`
    })
    .join(' AND ')
}

function isDefault(v: EditValue): v is { default: true } {
  return typeof v === 'object' && v !== null && 'default' in v
}

/** One statement applyChanges runs. `index` is the change's position in its list, to point a failure at its row. */
export interface ChangeStatement {
  kind: 'delete' | 'update' | 'insert'
  index: number
  text: string
  values: unknown[]
}

/**
 * The statements for a set of row changes, in the order they run (deletes, updates, inserts).
 * Every column and row key is checked before a statement is built, so nothing runs on a bad change.
 */
export function changeStatements(shape: RelationShape, changes: RowChanges, table: string): ChangeStatement[] {
  const useCtid = shape.primaryKey.length === 0
  if (useCtid && shape.kind !== 'r') {
    throw new Error('This relation has no primary key and cannot be edited.')
  }
  const keyColumns = useCtid ? [] : shape.primaryKey
  for (const u of changes.updates) checkColumns(shape, [...Object.keys(u.values), ...keyColumns])
  for (const i of changes.inserts) checkColumns(shape, Object.keys(i.values))
  const checkKey = (key: RowKey) => {
    if (useCtid) {
      if (typeof key.ctid !== 'string') throw new Error('Missing ctid for row')
    } else {
      for (const k of keyColumns) if (!(k in key)) throw new Error(`Missing key column "${k}"`)
    }
  }
  changes.updates.forEach((u) => checkKey(u.key))
  changes.deletes.forEach((d) => checkKey(d.key))

  const statements: ChangeStatement[] = []
  for (const [index, del] of changes.deletes.entries()) {
    const values: unknown[] = []
    const key = useCtid ? { ctid: del.key.ctid ?? null } : pick(del.key, keyColumns)
    const text = `DELETE FROM ${table} WHERE ${keyCondition(key, values, useCtid)}`
    statements.push({ kind: 'delete', index, text, values })
  }
  for (const [index, upd] of changes.updates.entries()) {
    const entries = Object.entries(upd.values)
    if (!entries.length) continue
    const values: unknown[] = []
    const sets = entries.map(([col, v]) => {
      values.push(v)
      return `${quoteIdent(col)} = $${values.length}`
    })
    const key = useCtid ? { ctid: upd.key.ctid ?? null } : pick(upd.key, keyColumns)
    const text = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${keyCondition(key, values, useCtid)}`
    statements.push({ kind: 'update', index, text, values })
  }
  for (const [index, ins] of changes.inserts.entries()) {
    const entries = Object.entries(ins.values).filter(([, v]) => !isDefault(v))
    const values: unknown[] = []
    let text: string
    if (entries.length === 0) {
      text = `INSERT INTO ${table} DEFAULT VALUES`
    } else {
      const cols = entries.map(([c]) => quoteIdent(c))
      const params = entries.map(([, v]) => {
        values.push(v)
        return `$${values.length}`
      })
      text = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${params.join(', ')})`
    }
    statements.push({ kind: 'insert', index, text, values })
  }
  return statements
}

export async function applyChanges(
  connectionId: string,
  database: string,
  changes: RowChanges,
): Promise<ApplyChangesResult> {
  const { pool } = await poolFor(connectionId, database)
  const client = await pool.connect()
  const result: ApplyChangesResult = { ok: true, updated: 0, inserted: 0, deleted: 0 }
  const table = qualifiedName(changes.schema, changes.table)
  let current = ''
  let failed: { kind: 'delete' | 'update' | 'insert'; index: number } | undefined
  let broken = false
  try {
    const shape = await relationShape(client, changes.schema, changes.table)
    const statements = changeStatements(shape, changes, table)

    await client.query('BEGIN')

    for (const st of statements) {
      failed = { kind: st.kind, index: st.index }
      current = st.text
      const res = await client.query({ text: current, values: st.values, queryMode: 'extended' } as pg.QueryConfig)
      if (st.kind === 'insert') {
        result.inserted++
        continue
      }
      assertOne(res.rowCount, st.kind)
      if (st.kind === 'delete') result.deleted++
      else result.updated++
    }

    failed = undefined
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true
    })
    broken ||= !isPgError(err)
    return {
      ok: false,
      updated: 0,
      inserted: 0,
      deleted: 0,
      error: { ...pgErrorInfo(err), change: current || undefined, failed },
    }
  } finally {
    client.release(broken)
  }
}

function pick(key: RowKey, columns: string[]): RowKey {
  const out: RowKey = {}
  for (const c of columns) out[c] = key[c] ?? null
  return out
}

export function assertOne(rowCount: number | null, action: string) {
  if (rowCount === 0) {
    throw new Error(
      `Could not ${action} a row: it was not found. Someone else may have changed or deleted it. Refresh and try again.`,
    )
  }
  if ((rowCount ?? 0) > 1) {
    throw new Error(`Refusing to ${action} ${rowCount} rows at once: the row key is not unique.`)
  }
}

// ---------------------------------------------------------------------------
// Foreign key lookup
// ---------------------------------------------------------------------------

const LABEL_NAMES = ['name', 'title', 'label', 'display_name', 'full_name', 'username', 'email', 'code', 'slug']
/** a second column that tells rows with the same label apart ("Ayu Lim" ×3 → their e-mails) */
const DETAIL_NAMES = ['email', 'username', 'sku', 'code', 'slug', 'phone']

type Pool = Awaited<ReturnType<typeof poolFor>>['pool']

async function referenceColumns(pool: Pool, table: string, column: string) {
  const cols = await pool.query<{ name: string; type: string; category: string }>(
    `SELECT a.attname AS name, t.typname AS type, t.typcategory AS category
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table],
  )
  if (!cols.rows.some((c) => c.name === column)) throw new Error(`Column "${column}" not found in ${table}`)
  const textual = cols.rows.filter((c) => c.name !== column && c.category === 'S')
  const byName = (names: string[], skip?: string | null) =>
    names.map((n) => textual.find((c) => c.name.toLowerCase() === n && c.name !== skip)).find(Boolean)?.name ?? null
  const labelColumn = byName(LABEL_NAMES) ?? textual[0]?.name ?? null
  const detailColumn = labelColumn ? byName(DETAIL_NAMES, labelColumn) : null
  return { labelColumn, detailColumn }
}

/**
 * Rows of a referenced table for picking a foreign key value: the key plus one
 * readable column (name, title, email, … or the first text column), matched by search text.
 */
export async function lookupReferences(
  connectionId: string,
  database: string,
  req: { schema: string; table: string; column: string; search: string; limit: number },
): Promise<ReferenceLookup> {
  const { pool } = await poolFor(connectionId, database)
  const table = qualifiedName(req.schema, req.table)
  const { labelColumn, detailColumn } = await referenceColumns(pool, table, req.column)
  const key = quoteIdent(req.column)
  const label = labelColumn ? quoteIdent(labelColumn) : 'NULL'
  const detail = detailColumn ? quoteIdent(detailColumn) : 'NULL'
  const search = req.search.trim()
  const like = escapeLike(search)
  const res = await pool.query<{ value: string; label: string | null; detail: string | null }>({
    text: `SELECT ${key}::text AS value, ${label}::text AS label, ${detail}::text AS detail
             FROM ${table}
            WHERE $1 = '' OR ${key}::text ILIKE $2 OR ${label}::text ILIKE $3 OR ${detail}::text ILIKE $3
            ORDER BY (${key}::text = $1) DESC, ${labelColumn ? `${label} NULLS LAST, ` : ''}${key}
            LIMIT $4`,
    values: [search, `${like}%`, `%${like}%`, req.limit],
  })
  return { labelColumn, detailColumn, items: res.rows }
}

/** Labels for a set of key values (what the grid shows next to a foreign key). */
export async function referenceLabels(
  connectionId: string,
  database: string,
  req: { schema: string; table: string; column: string; values: string[] },
): Promise<ReferenceLookup> {
  const { pool } = await poolFor(connectionId, database)
  const table = qualifiedName(req.schema, req.table)
  const { labelColumn, detailColumn } = await referenceColumns(pool, table, req.column)
  if (!labelColumn || req.values.length === 0) return { labelColumn, detailColumn, items: [] }
  const key = quoteIdent(req.column)
  const res = await pool.query<{ value: string; label: string | null; detail: string | null }>({
    text: `SELECT ${key}::text AS value, ${quoteIdent(labelColumn)}::text AS label,
                  ${detailColumn ? quoteIdent(detailColumn) : 'NULL'}::text AS detail
             FROM ${table}
            WHERE ${key}::text = ANY($1::text[])`,
    values: [req.values],
  })
  return { labelColumn, detailColumn, items: res.rows }
}
