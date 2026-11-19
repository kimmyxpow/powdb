import type { GridRow, GridValue } from './types'

/**
 * Keeps one object per key for as long as its inputs stay the same (compared by identity).
 * Memoized rows then re-render only when their own data changed.
 */
export interface KeyedCache {
  /** the value stored for `key` while every input is identical to the last call; otherwise `make()`, stored for next time */
  get<T>(key: string, inputs: readonly unknown[], make: () => T): T
  /** forgets the keys that are not in `keys` any more (rows that left the grid) */
  retain(keys: ReadonlySet<string>): void
}

interface CacheEntry {
  inputs: readonly unknown[]
  value: unknown
}

export function createKeyedCache(): KeyedCache {
  const entries = new Map<string, CacheEntry>()
  return {
    get<T>(key: string, inputs: readonly unknown[], make: () => T): T {
      const hit = entries.get(key)
      if (hit && hit.inputs.length === inputs.length && hit.inputs.every((v, i) => v === inputs[i])) {
        return hit.value as T
      }
      const value = make()
      entries.set(key, { inputs: [...inputs], value })
      return value
    },
    retain(keys) {
      for (const key of entries.keys()) if (!keys.has(key)) entries.delete(key)
    },
  }
}

/** a save error that names a row: the columns PostgreSQL blamed, and its message */
export interface RowServerIssue {
  cols: readonly number[]
  message: string
}

/** the validation result of a row's cells, plus the save error that names it (undefined when there is none) */
export function issuesWithServerIssue(
  issues: Map<number, string>,
  serverIssue: RowServerIssue | undefined,
): Map<number, string> | undefined {
  if (serverIssue) for (const c of serverIssue.cols) if (!issues.has(c)) issues.set(c, serverIssue.message)
  return issues.size ? issues : undefined
}

export interface StoredRowInput {
  id: string
  /** the values as the database has them */
  values: readonly (GridValue | undefined)[]
  edits: ReadonlyMap<number, GridValue> | undefined
  deleted: boolean
  serverIssue: RowServerIssue | undefined
}

/**
 * The grid row of a stored row with its staged changes. While the row's inputs are the same, the
 * same object comes back, so editing one row gives a new object for that row only.
 * `columns` is the identity of the column shape that `validate` depends on.
 */
export function storedGridRow(
  cache: KeyedCache,
  input: StoredRowInput,
  columns: unknown,
  validate: (value: GridValue, col: number) => string | null | undefined,
): GridRow {
  const { id, values, edits, deleted, serverIssue } = input
  return cache.get(id, [values, edits, deleted, serverIssue, columns], () => {
    const issues = new Map<number, string>()
    if (edits && !deleted) {
      for (const [c, v] of edits) {
        const problem = validate(v, c)
        if (problem) issues.set(c, problem)
      }
    }
    return {
      id,
      values: (edits ? values.map((v, c) => (edits.has(c) ? edits.get(c)! : v)) : values) as GridRow['values'],
      edited: edits && edits.size ? new Set(edits.keys()) : undefined,
      status: deleted ? 'deleted' : undefined,
      issues: issuesWithServerIssue(issues, serverIssue),
    }
  })
}

export interface IdentityBox<T> {
  value?: T
}

export function createIdentityBox<T>(): IdentityBox<T> {
  return {}
}

/**
 * The value from the last call while `same` says the new one is equal to it, else the new value
 * (held for the next call). Memoized children that take the value then see the same object.
 */
export function keepIdentity<T>(box: IdentityBox<T>, next: T, same: (prev: T, next: T) => boolean): T {
  if (box.value !== undefined && same(box.value, next)) return box.value
  box.value = next
  return next
}

export function sameElements<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** structural equality for plain data: primitives, arrays, Maps and plain objects */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameData(v, b[i]))
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) if (!b.has(key) || !sameData(value, b.get(key))) return false
    return true
  }
  const recordA = a as Record<string, unknown>
  const recordB = b as Record<string, unknown>
  const keys = Object.keys(recordA)
  return (
    keys.length === Object.keys(recordB).length &&
    keys.every((k) => Object.prototype.hasOwnProperty.call(recordB, k) && sameData(recordA[k], recordB[k]))
  )
}
