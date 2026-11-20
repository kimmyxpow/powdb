import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { createSavedViewFn, deleteSavedViewFn, listSavedViewsFn, updateSavedViewFn } from '@/api/saved-views.functions'
import type { TableSearch } from '@/components/table/table-data'
import type { SavedViewState } from '@/lib/types'

/** Every saved-views key starts with this, so one invalidation refreshes all tables. */
const ROOT = 'saved-views' as const

export const savedViewsQuery = (connectionId: string, database: string, schema: string, table: string) =>
  queryOptions({
    queryKey: [ROOT, connectionId, database, schema, table] as const,
    queryFn: () => listSavedViewsFn({ data: { connectionId, database, schema, table } }),
    staleTime: 30_000,
  })

function useInvalidateViews() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [ROOT] })
}

/** The table a view belongs to. */
export interface SavedViewTarget {
  connectionId: string
  database: string
  schema: string
  table: string
}

export interface SavedViewInput extends SavedViewTarget {
  name: string
  state: SavedViewState
}

export function useCreateSavedView() {
  const invalidate = useInvalidateViews()
  return useMutation({
    mutationFn: (input: SavedViewInput) => createSavedViewFn({ data: input }),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateSavedView() {
  const invalidate = useInvalidateViews()
  return useMutation({
    mutationFn: (input: { id: string; patch: { name?: string; state?: SavedViewState } }) =>
      updateSavedViewFn({ data: input }),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteSavedView() {
  const invalidate = useInvalidateViews()
  return useMutation({
    mutationFn: (id: string) => deleteSavedViewFn({ data: { id } }),
    onSuccess: () => invalidate(),
  })
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** An empty or blank text is null, so "no search" compares equal whatever it was stored as. */
function text(value: string | null | undefined): string | null {
  return value?.trim() ? value : null
}

/** The hidden column names without duplicates, sorted. The order the user hid them in does not matter. */
function hiddenKey(names: readonly string[]): string {
  return JSON.stringify([...new Set(names)].sort())
}

/** Whether two view states are the same. Order matters for sort and filters, not for hidden columns. */
export function sameViewState(a: SavedViewState, b: SavedViewState): boolean {
  return (
    a.sort.length === b.sort.length &&
    a.sort.every((s, i) => s.column === b.sort[i]!.column && s.direction === b.sort[i]!.direction) &&
    a.filters.length === b.filters.length &&
    a.filters.every((f, i) => {
      const g = b.filters[i]!
      return f.column === g.column && f.op === g.op && (f.value ?? '') === (g.value ?? '')
    }) &&
    text(a.where) === text(b.where) &&
    text(a.q) === text(b.q) &&
    hiddenKey(a.hiddenColumns) === hiddenKey(b.hiddenColumns)
  )
}

/** The view state of the table page as it is now. */
export function currentViewState(search: TableSearch, hiddenColumns: readonly string[]): SavedViewState {
  return {
    sort: search.sort ?? [],
    filters: search.filters ?? [],
    where: text(search.where),
    q: text(search.q),
    hiddenColumns: [...hiddenColumns],
  }
}

/** True when the state has no filter, sort, search, SQL condition or hidden column. */
export function isEmptyViewState(state: SavedViewState): boolean {
  return (
    state.sort.length === 0 &&
    state.filters.length === 0 &&
    text(state.where) === null &&
    text(state.q) === null &&
    state.hiddenColumns.length === 0
  )
}

/**
 * The hidden columns of a view that exist in the table now. A column that was removed is dropped.
 * If that would hide every column, nothing is hidden.
 */
export function existingHiddenColumns(hidden: readonly string[], columns: readonly string[]): string[] {
  const kept = [...new Set(hidden)].filter((name) => columns.includes(name))
  return kept.length >= columns.length ? [] : kept
}
