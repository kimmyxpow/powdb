/**
 * Streaming reads with plain SQL cursors (DECLARE / FETCH / CLOSE) over the existing pg client.
 * The same pool connection, session settings and statement_timeout apply
 * as for an ordinary query.
 */
import { firstKeyword } from '@/lib/sql'
import { classifySql } from '@/lib/sql-safety'
import { randomBytes } from 'node:crypto'
import type pg from 'pg'

interface CursorOptions {
  rowMode?: 'array'
  /** custom type parsers, e.g. rawTypes from pool.server */
  types?: pg.CustomTypesConfig
  /**
   * true when the caller already runs inside a transaction. A cursor needs one. When this is
   * false (the default) the helper opens its own with BEGIN, then COMMITs on success or
   * ROLLBACKs on error.
   */
  inTransaction?: boolean
}

export interface CursorBatch {
  rows: unknown[][]
  /** field metadata from this FETCH (every FETCH carries it, so the first batch has the columns) */
  fields: pg.FieldDef[]
}

interface StatementRows {
  rows: unknown[][]
  fields: pg.FieldDef[]
  command: string | null
  rowCount: number | null
}

const CURSOR_PREFIX = 'powview_cur_'

/** A unique, safe cursor name: 42 characters, well under Postgres' 63 byte identifier limit. */
export function newCursorName(hex: string = randomBytes(16).toString('hex')): string {
  return `${CURSOR_PREFIX}${hex}`
}

function cursorBody(text: string): string {
  return text.replace(/[\s;]+$/, '')
}

export function declareSql(name: string, text: string): string {
  return `DECLARE ${name} NO SCROLL CURSOR FOR ${cursorBody(text)}`
}

export function fetchSql(name: string, count: number): string {
  return `FETCH FORWARD ${count} FROM ${name}`
}

export function closeSql(name: string): string {
  return `CLOSE ${name}`
}

export { firstKeyword }

const CURSOR_LEADING_KEYWORDS = new Set(['select', 'values', 'table', 'with'])

/**
 * True when DECLARE can take this text: a SELECT, VALUES, TABLE or WITH statement that reads
 * only. Other statements (DML, DDL, EXPLAIN, SHOW, ...) must run as ordinary queries.
 */
export function canDeclareCursor(text: string): boolean {
  const keyword = firstKeyword(text)
  if (keyword === null || !CURSOR_LEADING_KEYWORDS.has(keyword)) return false
  // Writes (INSERT/UPDATE/DELETE/MERGE in a WITH, SELECT INTO) cannot go through a cursor.
  // classifySql skips strings and comments, so a word like "into" inside a literal does not
  // push a large SELECT onto the path that loads every row into memory.
  return !classifySql(text).changes
}

/**
 * Yields the rows of one query in batches of `batchSize`, through a cursor. The generator
 * closes the cursor when it ends or is returned early. An owned transaction is committed when
 * the generator stops normally or returned early, and rolled back after an error.
 */
export async function* readInBatches(
  client: pg.ClientBase,
  text: string,
  values: unknown[],
  batchSize: number,
  options: CursorOptions = {},
): AsyncGenerator<CursorBatch> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, got ${batchSize}`)
  }
  const name = newCursorName()
  const ownTransaction = options.inTransaction !== true
  const config = (sql: string, params: unknown[] = []) =>
    ({
      text: sql,
      values: params,
      queryMode: 'extended',
      rowMode: options.rowMode,
      types: options.types,
    }) as pg.QueryConfig

  if (ownTransaction) await client.query('BEGIN')
  let declared = false
  let failed = false
  try {
    await client.query(config(declareSql(name, text), values))
    declared = true
    for (;;) {
      const res = await client.query(config(fetchSql(name, batchSize)))
      const rows = res.rows as unknown[][]
      yield { rows, fields: res.fields }
      if (rows.length < batchSize) return
    }
  } catch (err) {
    failed = true
    throw err
  } finally {
    // After an error the transaction is aborted and CLOSE fails. Its rollback drops the cursor anyway.
    if (declared) await client.query(closeSql(name)).catch(() => {})
    if (ownTransaction) {
      if (failed) await client.query('ROLLBACK').catch(() => {})
      else await client.query('COMMIT')
    }
  }
}

/**
 * Reads at most `limit` rows of one statement. Pass a limit one above the row cap to learn
 * whether the result was cut short. SELECT-like text streams through a cursor. Any other
 * statement (DML with RETURNING, DDL, ...) runs as an ordinary query and its full result comes back.
 */
export async function readStatementRows(
  client: pg.ClientBase,
  text: string,
  limit: number,
  options: { types?: pg.CustomTypesConfig; inTransaction?: boolean } = {},
): Promise<StatementRows> {
  if (!canDeclareCursor(text)) {
    const config = {
      text,
      values: [],
      queryMode: 'extended',
      rowMode: 'array',
      types: options.types,
    } as pg.QueryConfig
    const res = await client.query(config)
    return {
      rows: res.rows as unknown[][],
      fields: res.fields,
      command: res.command || null,
      rowCount: res.rowCount,
    }
  }
  const rows: unknown[][] = []
  let fields: pg.FieldDef[] = []
  for await (const batch of readInBatches(client, text, [], limit, {
    rowMode: 'array',
    types: options.types,
    inTransaction: options.inTransaction,
  })) {
    fields = batch.fields
    for (const row of batch.rows) rows.push(row)
    if (rows.length >= limit) break
  }
  // A SELECT-like statement reports the command SELECT, as the server does for these.
  return { rows: rows.slice(0, limit), fields, command: 'SELECT', rowCount: rows.length }
}
