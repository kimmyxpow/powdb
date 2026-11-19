import type { GridValue } from '@/components/grid/types'
import { isDefaultMarker } from '@/components/grid/types'
import { displayIdent, displayQualified, quoteLiteral } from '@/lib/sql'
import type { Cell, RowChanges, RowKey } from '@/lib/types'

export interface PendingChanges {
  edits: Map<string, Map<number, Cell>>
  inserts: { id: string; values: Map<number, GridValue> }[]
  deletes: Set<string>
}

export const emptyPending = (): PendingChanges => ({ edits: new Map(), inserts: [], deletes: new Set() })

/**
 * Counts of the staged changes. With `keyFor` only what buildChanges would emit is counted (the
 * edits and deletes it sends); without it every staged edit and delete is, as the leave-page guard needs.
 */
export function pendingStats(p: PendingChanges, keyFor?: (rowId: string) => RowKey | null) {
  let edited = 0
  let deleted = p.deletes.size
  if (keyFor) {
    edited = editedRows(p, keyFor).length
    deleted = deletedRows(p, keyFor).length
  } else {
    for (const id of p.edits.keys()) if (!p.deletes.has(id)) edited++
  }
  return {
    edited,
    inserted: p.inserts.length,
    deleted,
    total: edited + p.inserts.length + deleted,
  }
}

/** The edited existing rows that can be addressed (not deleted, has a key), in save order. */
function editedRows(p: PendingChanges, keyFor: (rowId: string) => RowKey | null) {
  const out: { rowId: string; key: RowKey; edits: Map<number, Cell> }[] = []
  for (const [rowId, edits] of p.edits) {
    if (p.deletes.has(rowId) || edits.size === 0) continue
    const key = keyFor(rowId)
    if (key) out.push({ rowId, key, edits })
  }
  return out
}

/** The deleted rows that can be addressed (have a key), in save order. */
function deletedRows(p: PendingChanges, keyFor: (rowId: string) => RowKey | null) {
  const out: { rowId: string; key: RowKey }[] = []
  for (const rowId of p.deletes) {
    const key = keyFor(rowId)
    if (key) out.push({ rowId, key })
  }
  return out
}

export function buildChanges(
  schema: string,
  table: string,
  p: PendingChanges,
  fieldNames: string[],
  keyFor: (rowId: string) => RowKey | null,
): RowChanges {
  const changes: RowChanges = { schema, table, updates: [], inserts: [], deletes: [] }
  for (const { key, edits } of editedRows(p, keyFor)) {
    const values: Record<string, Cell> = {}
    for (const [col, v] of edits) values[fieldNames[col]!] = v
    changes.updates.push({ key, values })
  }
  for (const ins of p.inserts) {
    const values: Record<string, Cell | { default: true }> = {}
    for (const [col, v] of ins.values) values[fieldNames[col]!] = v
    changes.inserts.push({ values })
  }
  for (const { key } of deletedRows(p, keyFor)) changes.deletes.push({ key })
  return changes
}

function literal(v: Cell | { default: true }): string {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (isDefaultMarker(v)) return 'DEFAULT'
  return quoteLiteral(v)
}

function whereKey(key: RowKey): string {
  return Object.entries(key)
    .map(([col, v]) =>
      col === 'ctid'
        ? `ctid = ${literal(v)}::tid`
        : v === null
          ? `${displayIdent(col)} IS NULL`
          : `${displayIdent(col)} = ${literal(v)}`,
    )
    .join(' AND ')
}

/** Human-readable SQL for review (the server runs parameterized statements). */
export function previewSql(changes: RowChanges): string {
  const t = displayQualified(changes.schema, changes.table)
  const lines: string[] = ['BEGIN;', '']
  for (const d of changes.deletes) lines.push(`DELETE FROM ${t} WHERE ${whereKey(d.key)};`)
  for (const u of changes.updates) {
    const sets = Object.entries(u.values).map(([c, v]) => `${displayIdent(c)} = ${literal(v)}`)
    lines.push(`UPDATE ${t} SET ${sets.join(', ')} WHERE ${whereKey(u.key)};`)
  }
  for (const i of changes.inserts) {
    const entries = Object.entries(i.values).filter(([, v]) => !isDefaultMarker(v))
    lines.push(
      entries.length
        ? `INSERT INTO ${t} (${entries.map(([c]) => displayIdent(c)).join(', ')}) VALUES (${entries.map(([, v]) => literal(v)).join(', ')});`
        : `INSERT INTO ${t} DEFAULT VALUES;`,
    )
  }
  lines.push('', 'COMMIT;')
  return lines.join('\n')
}

/** Row ids in the order buildChanges lists them, to point a failed change back at its row. */
export function changeRowIds(p: PendingChanges, keyFor: (rowId: string) => RowKey | null) {
  const update = editedRows(p, keyFor).map((r) => r.rowId)
  const insert = p.inserts.map((i) => i.id)
  const deletes = deletedRows(p, keyFor).map((r) => r.rowId)
  return { update, insert, delete: deletes }
}

/**
 * Where a saved new row is in the refreshed rows: found by the primary key values it was
 * saved with. -1 when it cannot be told apart (no primary key, a key the database filled in,
 * or the row is not on this page).
 */
export function savedRowIndex(
  staged: ReadonlyMap<number, unknown> | undefined,
  keyFields: readonly number[],
  rows: readonly (readonly unknown[])[],
): number {
  if (!staged || keyFields.length === 0) return -1
  const wanted = keyFields.map((f) => staged.get(f))
  if (!wanted.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) return -1
  return rows.findIndex((r) => keyFields.every((f, j) => String(r[f]) === String(wanted[j])))
}
