import path from 'node:path'
import type { SavedQuery } from '@/lib/types'
import { writeJsonFile } from './json-file.server'
import { dataDir } from './store.server'

const SAVED_QUERY_NAME_MAX = 120
export const SAVED_QUERY_SQL_MAX = 1_000_000
const SAVED_QUERY_NOT_FOUND = 'Saved query not found.'
const SAVED_QUERIES_FILE = 'saved-queries.json'

interface SavedQueryCreate {
  name: string
  sql: string
  connectionId: string | null
  database: string | null
}

interface SavedQueryPatch {
  name?: string
  sql?: string
  connectionId?: string | null
  database?: string | null
}

interface SavedQueryFile {
  version: 1
  queries: SavedQuery[]
}

// ---------------------------------------------------------------------------
// Pure helpers (no filesystem)
// ---------------------------------------------------------------------------

/** Trims and checks a name. Throws a user-facing message when it is not usable. */
export function cleanName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name is required.')
  if (trimmed.length > SAVED_QUERY_NAME_MAX) {
    throw new Error(`Name must be ${SAVED_QUERY_NAME_MAX} characters or fewer.`)
  }
  return trimmed
}

export function checkSql(sql: string): string {
  if (sql.length > SAVED_QUERY_SQL_MAX) throw new Error('SQL is too long (max 1 MB).')
  return sql
}

function cleanDatabase(database: string | null): string | null {
  return database?.trim() || null
}

/** A query is listed for a connection when it belongs to it or to every connection. */
export function isVisibleFor(query: SavedQuery, connectionId: string): boolean {
  return query.connectionId === null || query.connectionId === connectionId
}

/** Newest update first. Returns a new array. */
export function sortNewestFirst(queries: SavedQuery[]): SavedQuery[] {
  return [...queries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export function visibleQueries(queries: SavedQuery[], connectionId: string): SavedQuery[] {
  return sortNewestFirst(queries.filter((q) => isVisibleFor(q, connectionId)))
}

export function newQueryRecord(input: SavedQueryCreate, id: string, now: string): SavedQuery {
  return {
    id,
    name: cleanName(input.name),
    sql: checkSql(input.sql),
    connectionId: input.connectionId || null,
    database: cleanDatabase(input.database),
    createdAt: now,
    updatedAt: now,
  }
}

/** Returns the query with the patch applied. Fields left undefined keep their value. */
export function applyPatch(query: SavedQuery, patch: SavedQueryPatch, now: string): SavedQuery {
  return {
    ...query,
    name: patch.name === undefined ? query.name : cleanName(patch.name),
    sql: patch.sql === undefined ? query.sql : checkSql(patch.sql),
    connectionId: patch.connectionId === undefined ? query.connectionId : patch.connectionId || null,
    database: patch.database === undefined ? query.database : cleanDatabase(patch.database),
    updatedAt: now,
  }
}

/** A new id that is not used by any query yet (8 random characters, like other ids in the store). */
export function newId(taken: Set<string>): string {
  for (;;) {
    const id = crypto.randomUUID().slice(0, 8)
    if (!taken.has(id)) return id
  }
}

/**
 * Reads the file contents. An empty or missing file is an empty list. A file that cannot be
 * parsed throws instead of being treated as empty, so the next save cannot wipe it.
 */
export function parseFile(raw: string | null): SavedQuery[] {
  if (raw === null || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${SAVED_QUERIES_FILE} is not valid JSON. Fix or remove the file.`)
  }
  const queries = (parsed as Partial<SavedQueryFile> | null)?.queries
  if (!Array.isArray(queries)) {
    throw new Error(`${SAVED_QUERIES_FILE} has an unexpected format. Fix or remove the file.`)
  }
  return queries as SavedQuery[]
}

// ---------------------------------------------------------------------------
// File access. Writes are serialized, so two quick saves cannot lose each other's change.
// ---------------------------------------------------------------------------

function savedQueriesFile(): string {
  return path.join(dataDir(), SAVED_QUERIES_FILE)
}

async function readQueries(): Promise<SavedQuery[]> {
  let raw: string | null
  try {
    raw = await Bun.file(savedQueriesFile()).text()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    raw = null
  }
  return parseFile(raw)
}

async function writeQueries(queries: SavedQuery[]): Promise<void> {
  const data: SavedQueryFile = { version: 1, queries }
  await writeJsonFile(savedQueriesFile(), data)
}

let chain: Promise<unknown> = Promise.resolve()

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function listSavedQueries(connectionId: string): Promise<SavedQuery[]> {
  return visibleQueries(await readQueries(), connectionId)
}

export function createSavedQuery(input: SavedQueryCreate): Promise<SavedQuery> {
  return exclusive(async () => {
    const queries = await readQueries()
    const now = new Date().toISOString()
    const query = newQueryRecord(input, newId(new Set(queries.map((q) => q.id))), now)
    await writeQueries([...queries, query])
    return query
  })
}

export function updateSavedQuery(id: string, patch: SavedQueryPatch): Promise<SavedQuery> {
  return exclusive(async () => {
    const queries = await readQueries()
    const index = queries.findIndex((q) => q.id === id)
    if (index === -1) throw new Error(SAVED_QUERY_NOT_FOUND)
    const next = applyPatch(queries[index]!, patch, new Date().toISOString())
    queries[index] = next
    await writeQueries(queries)
    return next
  })
}

export function deleteSavedQuery(id: string): Promise<void> {
  return exclusive(async () => {
    const queries = await readQueries()
    if (!queries.some((q) => q.id === id)) throw new Error(SAVED_QUERY_NOT_FOUND)
    await writeQueries(queries.filter((q) => q.id !== id))
  })
}
