import path from 'node:path'
import type { SavedView, SavedViewState } from '@/lib/types'
import { writeJsonFile } from './json-file.server'
import { newId } from './saved-queries.server'
import { dataDir } from './store.server'

export const SAVED_VIEW_NAME_MAX = 80
export const SAVED_VIEW_TEXT_MAX = 10_000
export const SAVED_VIEW_MAX_PER_TABLE = 50
export const SAVED_VIEW_MAX_SORTS = 20
export const SAVED_VIEW_MAX_FILTERS = 50
export const SAVED_VIEW_MAX_HIDDEN = 2000
const SAVED_VIEW_NOT_FOUND = 'Saved view not found.'
const SAVED_VIEWS_FILE = 'saved-views.json'

/** The table a view belongs to. */
export interface SavedViewTarget {
  connectionId: string
  database: string
  schema: string
  table: string
}

interface SavedViewCreate extends SavedViewTarget {
  name: string
  state: SavedViewState
}

interface SavedViewPatch {
  name?: string
  state?: SavedViewState
}

interface SavedViewFile {
  version: 1
  views: SavedView[]
}

// ---------------------------------------------------------------------------
// Pure helpers (no filesystem)
// ---------------------------------------------------------------------------

/** Trims and checks a view name. Throws a user-facing message when it is not usable. */
export function cleanName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Name is required.')
  if (trimmed.length > SAVED_VIEW_NAME_MAX) {
    throw new Error(`Name must be ${SAVED_VIEW_NAME_MAX} characters or fewer.`)
  }
  return trimmed
}

/** Checks the limits of a view state and returns it in its stored form. Throws when a limit is passed. */
export function cleanState(state: SavedViewState): SavedViewState {
  if (state.sort.length > SAVED_VIEW_MAX_SORTS) throw new Error(`Too many sort columns (max ${SAVED_VIEW_MAX_SORTS}).`)
  if (state.filters.length > SAVED_VIEW_MAX_FILTERS) {
    throw new Error(`Too many filters (max ${SAVED_VIEW_MAX_FILTERS}).`)
  }
  if ((state.where ?? '').length > SAVED_VIEW_TEXT_MAX) {
    throw new Error(`The SQL condition is too long (max ${SAVED_VIEW_TEXT_MAX.toLocaleString('en-US')} characters).`)
  }
  if ((state.q ?? '').length > SAVED_VIEW_TEXT_MAX) {
    throw new Error(`The search text is too long (max ${SAVED_VIEW_TEXT_MAX.toLocaleString('en-US')} characters).`)
  }
  if (state.hiddenColumns.length > SAVED_VIEW_MAX_HIDDEN) {
    throw new Error(`Too many hidden columns (max ${SAVED_VIEW_MAX_HIDDEN}).`)
  }
  return {
    sort: state.sort.map((s) => ({ column: s.column, direction: s.direction })),
    filters: state.filters.map((f) =>
      f.value === undefined ? { column: f.column, op: f.op } : { column: f.column, op: f.op, value: f.value },
    ),
    where: state.where?.trim() ? state.where : null,
    q: state.q?.trim() ? state.q : null,
    hiddenColumns: [...new Set(state.hiddenColumns)],
  }
}

/** Whether a view belongs to the table. */
export function isSameTable(view: SavedView, target: SavedViewTarget): boolean {
  return (
    view.connectionId === target.connectionId &&
    view.database === target.database &&
    view.schema === target.schema &&
    view.table === target.table
  )
}

/** The views of one table, sorted by name (case-insensitive). Returns a new array. */
export function viewsForTable(views: SavedView[], target: SavedViewTarget): SavedView[] {
  return views
    .filter((view) => isSameTable(view, target))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
}

/** Throws when the table already has `SAVED_VIEW_MAX_PER_TABLE` views. */
export function assertRoom(views: SavedView[], target: SavedViewTarget): void {
  if (viewsForTable(views, target).length >= SAVED_VIEW_MAX_PER_TABLE) {
    throw new Error(`This table already has ${SAVED_VIEW_MAX_PER_TABLE} saved views. Delete one first.`)
  }
}

/**
 * Throws when another view of the same table has this name (ignoring case). `exceptId` is the
 * view being renamed, which may keep its own name.
 */
export function assertUniqueName(views: SavedView[], target: SavedViewTarget, name: string, exceptId?: string): void {
  const wanted = name.toLowerCase()
  const taken = viewsForTable(views, target).some((view) => view.id !== exceptId && view.name.toLowerCase() === wanted)
  if (taken) throw new Error(`A view named "${name}" already exists for this table.`)
}

export function newViewRecord(input: SavedViewCreate, id: string, now: string): SavedView {
  return {
    id,
    name: cleanName(input.name),
    connectionId: input.connectionId,
    database: input.database,
    schema: input.schema,
    table: input.table,
    state: cleanState(input.state),
    createdAt: now,
    updatedAt: now,
  }
}

/** Returns the view with the patch applied. Fields left undefined keep their value. */
export function applyViewPatch(view: SavedView, patch: SavedViewPatch, now: string): SavedView {
  return {
    ...view,
    name: patch.name === undefined ? view.name : cleanName(patch.name),
    state: patch.state === undefined ? view.state : cleanState(patch.state),
    updatedAt: now,
  }
}

/**
 * Reads the file contents. An empty or missing file is an empty list. A file that cannot be
 * parsed throws instead of being treated as empty, so the next save cannot wipe it.
 */
export function parseFile(raw: string | null): SavedView[] {
  if (raw === null || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${SAVED_VIEWS_FILE} is not valid JSON. Fix or remove the file.`)
  }
  const views = (parsed as Partial<SavedViewFile> | null)?.views
  if (!Array.isArray(views)) {
    throw new Error(`${SAVED_VIEWS_FILE} has an unexpected format. Fix or remove the file.`)
  }
  return views as SavedView[]
}

// ---------------------------------------------------------------------------
// File access. Writes are serialized, so two quick saves cannot lose each other's change.
// ---------------------------------------------------------------------------

function savedViewsFile(): string {
  return path.join(dataDir(), SAVED_VIEWS_FILE)
}

async function readViews(): Promise<SavedView[]> {
  let raw: string | null
  try {
    raw = await Bun.file(savedViewsFile()).text()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    raw = null
  }
  return parseFile(raw)
}

async function writeViews(views: SavedView[]): Promise<void> {
  const data: SavedViewFile = { version: 1, views }
  await writeJsonFile(savedViewsFile(), data)
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

export async function listSavedViews(target: SavedViewTarget): Promise<SavedView[]> {
  return viewsForTable(await readViews(), target)
}

export function createSavedView(input: SavedViewCreate): Promise<SavedView> {
  return exclusive(async () => {
    const views = await readViews()
    assertRoom(views, input)
    const name = cleanName(input.name)
    assertUniqueName(views, input, name)
    const now = new Date().toISOString()
    const view = newViewRecord(input, newId(new Set(views.map((v) => v.id))), now)
    await writeViews([...views, view])
    return view
  })
}

export function updateSavedView(id: string, patch: SavedViewPatch): Promise<SavedView> {
  return exclusive(async () => {
    const views = await readViews()
    const index = views.findIndex((v) => v.id === id)
    if (index === -1) throw new Error(SAVED_VIEW_NOT_FOUND)
    const current = views[index]!
    if (patch.name !== undefined) assertUniqueName(views, current, cleanName(patch.name), id)
    const next = applyViewPatch(current, patch, new Date().toISOString())
    views[index] = next
    await writeViews(views)
    return next
  })
}

export function deleteSavedView(id: string): Promise<void> {
  return exclusive(async () => {
    const views = await readViews()
    if (!views.some((v) => v.id === id)) throw new Error(SAVED_VIEW_NOT_FOUND)
    await writeViews(views.filter((v) => v.id !== id))
  })
}
