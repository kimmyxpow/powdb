import type { TimeDisplay } from '@/lib/time'
import type { Cell, FilterOperator, ValueKind } from '@/lib/types'

export interface GridColumn {
  name: string
  typeName: string
  /** formatted type with modifiers, e.g. "character varying(80)" (for validation) */
  fullType?: string | null
  kind: ValueKind
  isPrimaryKey?: boolean
  foreignKey?: { schema: string; table: string; column: string } | null
  nullable?: boolean
  enumValues?: string[] | null
  /** identity ALWAYS / generated columns */
  readOnly?: boolean
  hasDefault?: boolean
  defaultValue?: string | null
  comment?: string | null
  /** foreign keys: readable label (and a second, telling column) of the referenced rows by key */
  refLabels?: ReadonlyMap<string, RefLabel>
  timeDisplay?: TimeDisplay
  /** shown in the header instead of the type name, e.g. "timestamptz · GMT+7" */
  typeLabel?: string
}

export interface RefLabel {
  label: string | null
  detail?: string | null
}

type DefaultMarker = { default: true }
export type GridValue = Cell | DefaultMarker

export function isDefaultMarker(v: GridValue | undefined): v is DefaultMarker {
  return typeof v === 'object' && v !== null && 'default' in v
}

export interface GridRow {
  id: string
  values: (GridValue | undefined)[]
  status?: 'new' | 'deleted'
  edited?: ReadonlySet<number>
  /** column index → what is wrong with the staged value (validation, or the last save) */
  issues?: ReadonlyMap<number, string>
}

export interface GridCallbacks {
  onCellChange?: (rowId: string, col: number, value: GridValue) => void
  /** many cells at once (paste), as one change */
  onCellsChange?: (changes: { rowId: string; col: number; value: GridValue }[]) => void
  onOpenRow?: (rowId: string) => void
  onFilter?: (column: string, op: FilterOperator, value?: string) => void
  onNavigateForeignKey?: (fk: NonNullable<GridColumn['foreignKey']>, value: string) => void
  onDeleteRows?: (ids: string[]) => void
  onDuplicateRow?: (rowId: string) => void
  /** the active cell moved (keyboard or mouse); null when nothing is active */
  onActiveCellChange?: (pos: { rowId: string; col: number } | null) => void
  onHideColumn?: (col: number) => void
}
