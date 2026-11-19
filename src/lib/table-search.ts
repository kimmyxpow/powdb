// Parses the URL search params of a table page. Runs in the browser (TanStack Router's
// validateSearch), so it is plain TypeScript and adds nothing to the client bundle.
import type { TableSearch } from '@/components/table/table-data'
import { FILTER_OPERATORS, type FilterOperator } from '@/lib/types'

type Plain = Record<string, unknown>

const TABS = ['data', 'structure', 'ddl'] as const

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A whole number in [min, max], read the way Number() reads it. */
function wholeNumber(value: unknown, min: number, max = Infinity): number | undefined {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseSort(value: unknown): TableSearch['sort'] {
  if (!Array.isArray(value)) return undefined
  const out: NonNullable<TableSearch['sort']> = []
  for (const item of value) {
    if (!isPlainObject(item)) return undefined
    const column = optionalString(item.column)
    const direction = item.direction
    if (column === undefined || (direction !== 'asc' && direction !== 'desc')) return undefined
    out.push({ column, direction })
  }
  return out
}

function parseFilters(value: unknown): TableSearch['filters'] {
  if (!Array.isArray(value)) return undefined
  const out: NonNullable<TableSearch['filters']> = []
  for (const item of value) {
    if (!isPlainObject(item)) return undefined
    const column = optionalString(item.column)
    const op = item.op
    if (column === undefined || !(FILTER_OPERATORS as readonly unknown[]).includes(op)) return undefined
    const filter: { column: string; op: FilterOperator; value?: string } = { column, op: op as FilterOperator }
    if (item.value !== undefined) {
      const v = optionalString(item.value)
      if (v === undefined) return undefined
      filter.value = v
    }
    out.push(filter)
  }
  return out
}

/**
 * Reads the table page's search params. A field that is missing or invalid becomes undefined
 * (and so drops out of the result). Unknown keys are dropped.
 */
export function parseTableSearch(search: Record<string, unknown>): TableSearch {
  // A key that is in the URL but invalid is kept with the value undefined: TanStack Router
  // lays the result over the raw search params, so a dropped key would let the raw,
  // unvalidated value through to the page.
  const out: TableSearch = {}
  const tab = search.tab
  if ('tab' in search) out.tab = (TABS as readonly unknown[]).includes(tab) ? (tab as TableSearch['tab']) : undefined

  if ('page' in search) out.page = wholeNumber(search.page, 1)
  if ('size' in search) out.size = wholeNumber(search.size, 1, 5000)
  if ('sort' in search) out.sort = parseSort(search.sort)
  if ('filters' in search) out.filters = parseFilters(search.filters)
  if ('where' in search) out.where = optionalString(search.where)
  if ('q' in search) out.q = optionalString(search.q)

  return out
}

/** Params of the rows query. The page size falls back to the user's default when the URL has none. */
export function rowsParams(search: TableSearch, defaultPageSize: number) {
  return {
    page: search.page ?? 1,
    pageSize: search.size ?? defaultPageSize,
    sort: search.sort ?? [],
    filters: search.filters ?? [],
    where: search.where,
    search: search.q,
  }
}

/** Params of the count query for the same view (no paging: it counts every matching row). */
export function countParams(search: TableSearch) {
  return {
    filters: search.filters ?? [],
    where: search.where,
    search: search.q,
  }
}
