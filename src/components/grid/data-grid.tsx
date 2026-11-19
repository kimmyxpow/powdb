import { useRowVirtualizer } from '../../hooks/use-row-virtualizer'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  CopyIcon,
  CircleSlashIcon,
  CopyPlusIcon,
  EqualIcon,
  EqualNotIcon,
  EyeOffIcon,
  FilterIcon,
  KeyRoundIcon,
  LinkIcon,
  Maximize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { memo, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Popover, PopoverPopup } from '@/components/ui/popover'
import { anchoredToastManager } from '@/components/ui/toast'
import { copyWithAnchoredToast } from '@/components/app/copy-feedback'
import { isMac, shortcut } from '@/hooks/use-hotkey'
import { rowToObject, toTsv } from '@/lib/export'
import { cellToText, countLabel } from '@/lib/format'
import type { Cell, Sort } from '@/lib/types'
import { cn } from '@/lib/utils'
import { isZoned, toLocalTimestamptz } from '@/lib/time'
import { validateValue } from '@/lib/validate'
import { CellContent } from './cell-content'
import { ForeignKeyField, TemporalPicker, columnSpec, isTemporal, textToValue } from './value-editors'
import type { GridCallbacks, GridColumn, GridRow, GridValue } from './types'
import { isDefaultMarker } from './types'
import { ValueDialog } from './value-dialog'
import type { ValueDialogState } from './value-dialog'

const ROW_H = 32
const HEADER_H = 34
const OPEN_W = 28
const MIN_W = 56
const MAX_INITIAL_W = 420
const TIP_DELAY = 400

// ---------------------------------------------------------------------------
// width estimation
// ---------------------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null = null
function measure(text: string, font: string): number {
  if (typeof document === 'undefined') return text.length * 7.5
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7.5
  measureCtx.font = font
  return measureCtx.measureText(text).width
}
const VALUE_FONT = '12.5px "Geist Mono Variable", ui-monospace, monospace'
const HEADER_FONT = '500 12.5px "Inter Variable", ui-sans-serif, system-ui, sans-serif'
const TYPE_FONT = '10.5px "Geist Mono Variable", ui-monospace, monospace'

function estimateWidth(column: GridColumn, rows: GridRow[], index: number): number {
  // padding (20) + gaps (12) + sort slot with its gap (18) + slack (4) + optional key icon (18)
  const header =
    measure(column.name, HEADER_FONT) +
    measure(column.typeName, TYPE_FONT) +
    (column.isPrimaryKey || column.foreignKey ? 18 : 0) +
    54
  const samples: number[] = []
  const n = Math.min(rows.length, 60)
  for (let i = 0; i < n; i++) {
    const v = rows[i]!.values[index]
    if (typeof v === 'string') samples.push(measure(v.length > 80 ? v.slice(0, 80) : v, VALUE_FONT))
    else if (typeof v === 'boolean') samples.push(52)
    else samples.push(36)
  }
  samples.sort((a, b) => a - b)
  // small samples: fit the widest value; larger ones: ignore outliers
  const pick = samples.length <= 30 ? samples.length - 1 : Math.floor(samples.length * 0.9)
  const p90 = samples.length ? samples[pick]! + 26 : 80
  // a foreign key also shows the referenced row's label
  let width = Math.max(header, p90 + (column.foreignKey ? 110 : 0))
  if (column.kind === 'boolean') width = Math.max(width, 84)
  return Math.round(Math.min(Math.max(width, MIN_W + 16), MAX_INITIAL_W))
}

const widthMemory = new Map<string, Record<string, number>>()

// ---------------------------------------------------------------------------

interface DataGridProps extends GridCallbacks {
  columns: GridColumn[]
  rows: GridRow[]
  rowNumberOffset?: number
  /** largest row number to expect (e.g. the table size), so the row-number column keeps its width across pages */
  rowCountHint?: number
  editable?: boolean
  sort?: Sort[]
  onSortChange?: (sort: Sort[]) => void
  selectedRows?: ReadonlySet<string>
  onSelectedRowsChange?: (ids: Set<string>) => void
  /** remember column widths under this key */
  storageKey?: string
  emptyState?: ReactNode
  /** move the active cell there (and scroll to it); `key` makes repeated jumps to the same cell work */
  jumpTo?: { rowId: string; col: number; key: number } | null
  onFilterColumn?: (column: string) => void
  /** row whose details are showing (its panel icon stays visible and closes them) */
  openRowId?: string | null
}

interface Pos {
  row: number
  col: number
}

/** what the rows do when used: all take the row's index (or id), so one object serves every row */
interface RowActions {
  onCellMouseDown(index: number, col: number, button: number): void
  onCellDoubleClick(index: number, col: number): void
  onToggleSelect(index: number, shift: boolean): void
  onCommitEdit(index: number, value: GridValue, move?: 'down' | 'right'): void
  onCancelEdit(): void
  onEditorFlush(fn: (() => void) | null): void
  onExpand(index: number, draft?: string): void
  onOpenRow(rowId: string): void
  onNavigateForeignKey(fk: NonNullable<GridColumn['foreignKey']>, value: string): void
}

/**
 * One object with the same functions for as long as the component lives. Each function calls the
 * handler of the latest render (stored in a ref at commit), so callers never hold a stale one.
 */
function useStableHandlers<T extends object>(handlers: T): T {
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  const [stable] = useState(() => {
    const out: Record<string, (...args: unknown[]) => unknown> = {}
    for (const key of Object.keys(handlers)) {
      out[key] = (...args: unknown[]) => (latest.current as Record<string, (...a: unknown[]) => unknown>)[key]!(...args)
    }
    return out as T
  })
  return stable
}

export function DataGrid({
  columns,
  rows,
  rowNumberOffset: rowNumberOffsetProp,
  rowCountHint: rowCountHintProp,
  editable: editableProp,
  sort,
  onSortChange,
  selectedRows,
  onSelectedRowsChange,
  storageKey,
  emptyState,
  onCellChange,
  onCellsChange,
  jumpTo,
  onOpenRow,
  onFilter,
  onNavigateForeignKey,
  onDeleteRows,
  onDuplicateRow,
  onActiveCellChange,
  onHideColumn,
  onFilterColumn,
  openRowId,
}: DataGridProps) {
  // the defaults, as ?? (the React Compiler does not support destructuring defaults)
  const rowNumberOffset = rowNumberOffsetProp ?? 0
  const rowCountHint = rowCountHintProp ?? 0
  const editable = editableProp ?? false
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<Pos | null>(null)
  // the cell being typed in; by row id, so it stays on its record when rows are inserted or move
  const [editing, setEditing] = useState<(Pos & { initial?: string; rowId: string }) | null>(null)
  const [valueDialog, setValueDialog] = useState<ValueDialogState | null>(null)
  const anchorRow = useRef<number | null>(null)
  // commits the open editor's text; the editor sets it on each render. Used when its row scrolls out of the window.
  const flushEditor = useRef<(() => void) | null>(null)
  const gridId = useId()

  // ---- column widths ------------------------------------------------------
  const signature = columns
    .map((c) => `${c.name}:${c.typeName}:${c.isPrimaryKey ? 'k' : ''}${c.foreignKey ? 'f' : ''}`)
    .join('|')
  const [widths, setWidths] = useState<number[]>([])
  const widthKey = `${signature}\u0000${storageKey ?? ''}`
  const [prevWidthKey, setPrevWidthKey] = useState<string | null>(null)
  if (widthKey !== prevWidthKey) {
    setPrevWidthKey(widthKey)
    const remembered = storageKey ? widthMemory.get(storageKey) : undefined
    setWidths(columns.map((c, i) => remembered?.[c.name] ?? estimateWidth(c, rows, i)))
    setActive(null)
    setEditing(null)
  }

  // the same array while nothing it is built from changed: the rows are memoized on it
  const colWidths = useMemo(
    () => columns.map((c, i) => widths[i] ?? estimateWidth(c, rows, i)),
    [columns, widths, rows],
  )
  const offsets: number[] = []
  let acc = 0
  for (const w of colWidths) {
    offsets.push(acc)
    acc += w
  }

  const maxRowNumber = Math.max(rowNumberOffset + rows.length, rowCountHint)
  const gutter = Math.max(52, String(maxRowNumber).length * 8 + 34)
  const openWidth = onOpenRow ? OPEN_W : 0
  // sticky area left of the data columns: row number / checkbox, then the open-row column
  const lead = gutter + openWidth
  const totalWidth = lead + colWidths.reduce((a, b) => a + b, 0)

  const setWidth = (index: number, width: number) => {
    setWidths((prev) => {
      const next = [...prev]
      next[index] = Math.max(MIN_W, Math.round(width))
      if (storageKey) {
        const mem = { ...widthMemory.get(storageKey) }
        mem[columns[index]!.name] = next[index]!
        widthMemory.set(storageKey, mem)
      }
      return next
    })
  }

  // ---- virtualizer -------------------------------------------------------
  const virtualizer = useRowVirtualizer({
    count: rows.length,
    rowHeight: ROW_H,
    overscan: 12,
    scrollRef,
    paddingStart: HEADER_H,
  })

  // brings a cell into view: its row (vertically) and its column (horizontally, beside the sticky columns).
  // The keyboard calls it in the same event that moves the cursor, so the scroll and the move are one render.
  const revealCell = (pos: Pos) => {
    virtualizer.scrollToIndex(pos.row)
    const el = scrollRef.current
    if (!el) return
    const left = offsets[pos.col] ?? 0
    const right = left + (colWidths[pos.col] ?? 0)
    const viewLeft = el.scrollLeft
    const viewRight = el.scrollLeft + el.clientWidth - lead
    if (left < viewLeft) el.scrollLeft = left
    else if (right > viewRight) el.scrollLeft = right - (el.clientWidth - lead)
  }
  // keep active cell in view when it moves by other means (mouse, jump, a commit that moves it)
  const keepActiveInView = useEffectEvent(() => {
    if (active) revealCell(active)
  })
  useEffect(() => keepActiveInView(), [active?.row, active?.col])

  // The active cell stays on its record when rows are inserted above it or removed
  // (adding, duplicating or discarding a row must not move it onto another one).
  const activeRowId = useRef<string | null>(null)
  useLayoutEffect(() => {
    setActive((a) => {
      if (!a) return a
      let row = a.row
      const id = activeRowId.current
      if (id && rows[row]?.id !== id) {
        row = rows.findIndex((r) => r.id === id)
        if (row < 0) return null // its row is gone (other page, discarded, …)
      }
      if (row >= rows.length || a.col >= columns.length) return null
      return row === a.row ? a : { ...a, row }
    })
    // an editor whose row left the grid closes (nothing else would close it: the keys are off while it is open)
    setEditing((e) => (e && !rows.some((r) => r.id === e.rowId) ? null : e))
  }, [rows, columns.length])
  useEffect(() => {
    activeRowId.current = active ? (rows[active.row]?.id ?? null) : null
  }, [active, rows])

  // Report the active cell to the parent only when its position changes: right after rows are
  // inserted above it, the index points at another record until the layout effect above moves it.
  // The callback is read from a ref, so a new function on each render does not re-run this effect with a stale index.
  const reported = useRef<string | null>(null)
  const rowsNow = useRef(rows)
  const onActiveCellChangeRef = useRef(onActiveCellChange)
  // set on commit (a layout effect runs before the effect below, which reads them), not during render
  useLayoutEffect(() => {
    rowsNow.current = rows
    onActiveCellChangeRef.current = onActiveCellChange
  })
  // an effect event reads the latest cell; the effect itself is keyed on the position only
  const reportActiveCell = useEffectEvent(() => {
    const notify = onActiveCellChangeRef.current
    if (!notify) return
    const id = active ? rowsNow.current[active.row]?.id : undefined
    // right after rows were inserted above it, the index points at another record until the
    // layout effect above moves it along: wait for that instead of reporting the wrong row
    if (
      id &&
      activeRowId.current &&
      id !== activeRowId.current &&
      rowsNow.current.some((r) => r.id === activeRowId.current)
    )
      return
    const key = active && id ? `${id}\u0000${active.col}` : null
    if (key === reported.current) return
    reported.current = key
    notify(active && id ? { rowId: id, col: active.col } : null)
  })
  useEffect(() => {
    reportActiveCell()
  }, [active?.row, active?.col])

  // moves the cursor to jumpTo; only a new key (a repeated jump to the same cell) triggers it
  const jumpKey = jumpTo?.key
  const [prevJumpKey, setPrevJumpKey] = useState<number | undefined>(undefined)
  if (jumpKey !== prevJumpKey) {
    setPrevJumpKey(jumpKey)
    const row = jumpTo ? rows.findIndex((r) => r.id === jumpTo.rowId) : -1
    if (jumpTo && row >= 0) {
      setEditing(null)
      setActive({ row, col: Math.min(jumpTo.col, columns.length - 1) })
    }
  }
  // focus only once the cell was found, so a jump to a missing row leaves focus alone
  const focusJumpTarget = useEffectEvent(() => {
    if (!jumpTo || rows.findIndex((r) => r.id === jumpTo.rowId) < 0) return
    scrollRef.current?.focus({ preventScroll: true })
  })
  useEffect(() => focusJumpTarget(), [jumpKey])

  const canEditCell = (row: number, col: number) => {
    const r = rows[row]
    const c = columns[col]
    return Boolean(editable && r && c && r.status !== 'deleted' && !(c.readOnly && r.status !== 'new'))
  }

  const commit = (pos: Pos, value: GridValue) => {
    const row = rows[pos.row]
    if (!row) return
    if (row.values[pos.col] !== value) onCellChange?.(row.id, pos.col, value)
  }

  const startEdit = (pos: Pos, initial?: string) => {
    if (!canEditCell(pos.row, pos.col)) return false
    const column = columns[pos.col]!
    const value = rows[pos.row]!.values[pos.col]
    // booleans flip in place (NULL / not set → true); NULL is one Delete away
    if (column.kind === 'boolean' && initial === undefined) {
      commit(pos, value !== true)
      return true
    }
    const text = typeof value === 'string' ? value : ''
    // long / multi-line values and JSON get the big editor
    if (
      initial === undefined &&
      (column.kind === 'json' || column.kind === 'array' || text.length > 120 || text.includes('\n'))
    ) {
      setValueDialog({ rowId: rows[pos.row]!.id, col: pos.col, value })
      return true
    }
    // a flush left by an earlier editor must not act for this one
    flushEditor.current = null
    setEditing({ ...pos, rowId: rows[pos.row]!.id, initial })
    return true
  }

  /** The element a copied cell's toast points at (the cell, else the grid). */
  const cellElement = (pos: Pos): Element | null =>
    scrollRef.current?.querySelector(`[data-row="${pos.row}"][data-col="${pos.col}"]`) ?? scrollRef.current

  const copyValue = (pos: Pos) => {
    const v = rows[pos.row]?.values[pos.col]
    const text = v === undefined || isDefaultMarker(v) ? '' : cellToText(v)
    void copyWithAnchoredToast(text, cellElement(pos), 'Copied')
  }

  const copySelectedRows = () => {
    const picked = rows.filter((r) => selectedRows?.has(r.id))
    const data = picked.map((r) => r.values.map((v) => (v === undefined || isDefaultMarker(v) ? null : v)) as Cell[])
    void copyWithAnchoredToast(
      toTsv(columns, data),
      scrollRef.current,
      `Copied ${countLabel(picked.length, 'row')}`,
      1500,
    )
  }

  const toggleRow = (index: number, shift: boolean) => {
    if (!onSelectedRowsChange) return
    const next = new Set(selectedRows ?? [])
    const id = rows[index]!.id
    if (shift && anchorRow.current !== null) {
      const [a, b] = [anchorRow.current, index].sort((x, y) => x - y)
      for (let i = a!; i <= b!; i++) next.add(rows[i]!.id)
    } else if (next.has(id)) next.delete(id)
    else next.add(id)
    anchorRow.current = index
    onSelectedRowsChange(next)
  }

  const toggleSort = (column: string, additive: boolean) => {
    if (!onSortChange) return
    const current = sort ?? []
    const existing = current.find((s) => s.column === column)
    let next: Sort[]
    if (!existing) {
      next = additive ? [...current, { column, direction: 'asc' }] : [{ column, direction: 'asc' }]
    } else if (existing.direction === 'asc') {
      next = current.map((s) => (s.column === column ? { ...s, direction: 'desc' as const } : s))
      if (!additive) next = next.filter((s) => s.column === column)
    } else {
      next = current.filter((s) => s.column !== column)
      if (!additive) next = []
    }
    onSortChange(next)
  }

  // ---- keyboard ---------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || valueDialog) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'a' && onSelectedRowsChange) {
      e.preventDefault()
      onSelectedRowsChange(new Set(rows.map((r) => r.id)))
      return
    }
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      if (active) copyValue(active)
      else if (selectedRows?.size) copySelectedRows()
      return
    }
    if (active && editable && mod && (e.key === 'Delete' || e.key === 'Backspace') && onDeleteRows) {
      e.preventDefault()
      onDeleteRows(selectedRows?.size ? [...selectedRows] : [rows[active.row]!.id])
      return
    }
    if (active && editable && e.altKey && e.shiftKey && e.code === 'KeyD' && onDuplicateRow) {
      e.preventDefault()
      if (rows[active.row]!.status !== 'deleted') onDuplicateRow(rows[active.row]!.id)
      return
    }
    if (active && e.key === 'Enter' && e.shiftKey && !mod) {
      e.preventDefault()
      if (isTemporal(columns[active.col]!.kind) && startEdit(active)) return
      setValueDialog({ rowId: rows[active.row]!.id, col: active.col, value: rows[active.row]!.values[active.col] })
      return
    }
    if (e.key === 'Escape') {
      if (selectedRows?.size) onSelectedRowsChange?.(new Set())
      setActive(null)
      return
    }
    if (!active) {
      if (rows.length && columns.length && /^Arrow|^Tab$|^Enter$/.test(e.key)) {
        e.preventDefault()
        setActive({ row: 0, col: 0 })
      }
      return
    }
    const lastRow = rows.length - 1
    const lastCol = columns.length - 1
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 2)
    let next: Pos | null = null
    switch (e.key) {
      case 'ArrowUp':
        next = { row: mod ? 0 : Math.max(0, active.row - 1), col: active.col }
        break
      case 'ArrowDown':
        next = { row: mod ? lastRow : Math.min(lastRow, active.row + 1), col: active.col }
        break
      case 'ArrowLeft':
        next = { row: active.row, col: mod ? 0 : Math.max(0, active.col - 1) }
        break
      case 'ArrowRight':
        next = { row: active.row, col: mod ? lastCol : Math.min(lastCol, active.col + 1) }
        break
      case 'Home':
        next = { row: mod ? 0 : active.row, col: 0 }
        break
      case 'End':
        next = { row: mod ? lastRow : active.row, col: lastCol }
        break
      case 'PageUp':
        next = { row: Math.max(0, active.row - page), col: active.col }
        break
      case 'PageDown':
        next = { row: Math.min(lastRow, active.row + page), col: active.col }
        break
      case 'Tab':
        next = e.shiftKey
          ? active.col > 0
            ? { row: active.row, col: active.col - 1 }
            : { row: Math.max(0, active.row - 1), col: lastCol }
          : active.col < lastCol
            ? { row: active.row, col: active.col + 1 }
            : { row: Math.min(lastRow, active.row + 1), col: 0 }
        break
      case 'Enter':
      case 'F2':
        e.preventDefault()
        if (!startEdit(active)) {
          setValueDialog({ rowId: rows[active.row]!.id, col: active.col, value: rows[active.row]!.values[active.col] })
        }
        return
      case ' ':
        e.preventDefault()
        onOpenRow?.(rows[active.row]!.id)
        return
      case 'Backspace':
      case 'Delete': {
        if (selectedRows?.size && editable && onDeleteRows) {
          e.preventDefault()
          onDeleteRows([...selectedRows])
          return
        }
        if (canEditCell(active.row, active.col) && columns[active.col]!.nullable) {
          e.preventDefault()
          commit(active, null)
        }
        return
      }
      default:
        // ("?" opens the shortcut list instead of starting an edit)
        if (e.key.length === 1 && e.key !== '?' && !mod && !e.altKey && canEditCell(active.row, active.col)) {
          const kind = columns[active.col]!.kind
          if (kind === 'boolean' && /^[tfyn10]$/i.test(e.key)) {
            e.preventDefault()
            commit(active, /^[ty1]$/i.test(e.key))
          } else if (kind !== 'boolean' && kind !== 'enum') {
            e.preventDefault()
            startEdit(active, e.key)
          }
        }
        return
    }
    if (next) {
      e.preventDefault()
      // the same value (an arrow at the edge) keeps the state, so nothing re-renders
      setActive((a) => (a && a.row === next.row && a.col === next.col ? a : next))
      revealCell(next)
    }
  }

  // ---- paste ----------------------------------------------------------------------
  // A block copied from a spreadsheet (or this grid) lands on the cells from the
  // active one rightwards/downwards; cells that cannot be edited are skipped.
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing || valueDialog || !active || !onCellsChange) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
    const changes: { rowId: string; col: number; value: GridValue }[] = []
    let skipped = 0
    lines.forEach((line, dr) => {
      line.split('\t').forEach((cell, dc) => {
        const row = active.row + dr
        const col = active.col + dc
        if (row >= rows.length || col >= columns.length) return
        if (!canEditCell(row, col)) {
          skipped += 1
          return
        }
        const column = columns[col]!
        const value: GridValue =
          column.kind === 'boolean' && /^(true|false|t|f)$/i.test(cell)
            ? /^t/i.test(cell)
            : textToValue(cell, column, rows[row]!.status === 'new')
        changes.push({ rowId: rows[row]!.id, col, value })
      })
    })
    if (changes.length) onCellsChange(changes)
    anchoredToastManager.add({
      title: `Pasted into ${countLabel(changes.length, 'cell')}${skipped ? ` · ${skipped} read-only skipped` : ''}`,
      positionerProps: { anchor: cellElement(active), side: 'top', sideOffset: 6 },
      timeout: 1600,
      data: { tooltipStyle: true },
    })
  }

  // ---- context menu -------------------------------------------------------------
  // The menu renders from a snapshot taken when it opens, so the actions it
  // triggers (delete, set NULL, …) cannot change it while it fades out.
  const [menuCell, setMenuCell] = useState<{
    pos: Pos
    row: GridRow
    column: GridColumn
    value: GridValue | undefined
    canEdit: boolean
    selected: string[]
  } | null>(null)

  const snapshotMenu = (pos: Pos | null) => {
    const row = pos ? rows[pos.row] : undefined
    const column = pos ? columns[pos.col] : undefined
    if (!pos || !row || !column) {
      setMenuCell(null)
      return
    }
    setMenuCell({
      pos,
      row,
      column,
      value: row.values[pos.col],
      canEdit: canEditCell(pos.row, pos.col),
      selected: [...(selectedRows ?? [])],
    })
  }

  // ---- row callbacks ----------------------------------------------------------
  // The rows get this one object. Its functions never change, and each call runs the handler of the
  // latest render, so a row does not re-render just because a handler was created again.
  const rowActions: RowActions = useStableHandlers({
    onCellMouseDown: (index: number, col: number, button: number) => {
      const pos = { row: index, col }
      // booleans flip with one click once their cell is selected (a double click = select + flip)
      if (
        button === 0 &&
        active?.row === pos.row &&
        active.col === col &&
        columns[col]?.kind === 'boolean' &&
        canEditCell(pos.row, col)
      ) {
        commit(pos, rows[index]!.values[col] !== true)
      }
      setActive(pos)
    },
    onCellDoubleClick: (index: number, col: number) => {
      const pos = { row: index, col }
      setActive(pos)
      if (columns[col]?.kind === 'boolean' && canEditCell(pos.row, col)) return // flipped on mouse down
      if (!startEdit(pos)) {
        setValueDialog({ rowId: rows[index]!.id, col, value: rows[index]!.values[col] })
      }
    },
    onToggleSelect: (index: number, shift: boolean) => toggleRow(index, shift),
    onCommitEdit: (index: number, value: GridValue, move?: 'down' | 'right') => {
      const pos = { row: index, col: editing!.col }
      commit(pos, value)
      setEditing(null)
      if (move === 'down') setActive({ row: Math.min(rows.length - 1, pos.row + 1), col: pos.col })
      if (move === 'right') setActive({ row: pos.row, col: Math.min(columns.length - 1, pos.col + 1) })
      // no scroll: a commit from a row that scrolled out must not pull the view back to the grid
      requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
    },
    onCancelEdit: () => {
      setEditing(null)
      scrollRef.current?.focus()
    },
    onEditorFlush: (fn: (() => void) | null) => {
      flushEditor.current = fn
    },
    onExpand: (index: number, draft?: string) => {
      const col = editing!.col
      setEditing(null)
      setValueDialog({ rowId: rows[index]!.id, col, value: rows[index]!.values[col], draft })
    },
    onOpenRow: (rowId: string) => onOpenRow?.(rowId),
    onNavigateForeignKey: (fk: NonNullable<GridColumn['foreignKey']>, value: string) =>
      onNavigateForeignKey?.(fk, value),
  })

  // ---- row buttons' tooltip ------------------------------------------------------
  // One tooltip for all row buttons: a Tooltip mounted per row was costly as rows scrolled in.
  // A button carries its text in data-tip and shows the tooltip after the same delay as the others.
  const [tip, setTip] = useState<{ anchor: Element; text: string; open: boolean } | null>(null)
  const tipElement = useRef<Element | null>(null)
  const tipTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(tipTimer.current), [])
  const hideTip = () => {
    window.clearTimeout(tipTimer.current)
    setTip((t) => (t?.open ? { ...t, open: false } : t))
  }
  const onTipPointerOver = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = (e.target as Element).closest('[data-tip]')
    if (!el || el === tipElement.current) return
    tipElement.current = el
    window.clearTimeout(tipTimer.current)
    tipTimer.current = window.setTimeout(
      () => setTip({ anchor: el, text: el.getAttribute('data-tip') ?? '', open: true }),
      TIP_DELAY,
    )
  }
  const onTipPointerOut = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = (e.target as Element).closest('[data-tip]')
    if (!el || el.contains(e.relatedTarget as Node | null)) return
    tipElement.current = null
    hideTip()
  }
  const onGridScroll = () => {
    tipElement.current = null
    hideTip()
  }

  // ---- render ---------------------------------------------------------------
  const virtualRows = virtualizer.items

  // the edited row scrolled out of the window: its slot is reused, so the editor unmounts without a blur.
  // Commit its text the way a blur would; without a flush, just close it.
  useLayoutEffect(() => {
    if (!editing) return
    if (virtualRows.some((vr) => rows[vr.index]?.id === editing.rowId)) return
    const flush = flushEditor.current
    flushEditor.current = null
    if (flush) flush()
    else setEditing(null)
  }, [editing, rows, virtualRows])

  // rows are in slot order (DOM order), which is a rotation of the visual order: screen readers follow aria-owns
  const rowIdsByIndex = [...virtualRows].sort((a, b) => a.index - b.index).map((vr) => `${gridId}-s${vr.slot}`)
  const sortMap = new Map((sort ?? []).map((s, i) => [s.column, { ...s, index: i }]))
  const allSelected = rows.length > 0 && rows.every((r) => selectedRows?.has(r.id))
  const someSelected = !allSelected && rows.some((r) => selectedRows?.has(r.id))
  const menuValue = menuCell?.value
  const fkValue =
    menuCell?.column.foreignKey && typeof menuValue === 'string' && menuCell.row.status !== 'new' ? menuValue : null
  const menuSelected = menuCell ? menuCell.selected.includes(menuCell.row.id) : false

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ContextMenu>
        <ContextMenuTrigger
          aria-colcount={columns.length}
          aria-owns={[`${gridId}-h`, ...rowIdsByIndex].join(' ')}
          aria-rowcount={rows.length}
          className="scrollbar-thin relative min-h-0 flex-1 overflow-auto font-mono text-[12.5px] outline-none"
          onContextMenu={(e: React.MouseEvent) => {
            const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]')
            const pos = cell ? { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } : active
            if (cell) setActive(pos)
            snapshotMenu(pos)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onPointerDown={hideTip}
          onPointerOut={onTipPointerOut}
          onPointerOver={onTipPointerOver}
          onScroll={onGridScroll}
          ref={scrollRef}
          render={<div />}
          role="grid"
          tabIndex={0}
        >
          <div className="relative" style={{ height: virtualizer.totalSize, width: totalWidth, minWidth: '100%' }}>
            {/* header */}
            <div
              className="sticky top-0 z-20 flex border-b bg-grid-header font-sans"
              id={`${gridId}-h`}
              role="row"
              style={{ height: HEADER_H, width: totalWidth, minWidth: '100%' }}
            >
              <div
                className="sticky left-0 z-30 flex shrink-0 items-center justify-center border-r bg-grid-header"
                style={{ width: gutter }}
              >
                {onSelectedRowsChange && rows.length > 0 && (
                  <Checkbox
                    aria-label="Select all rows"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onCheckedChange={(checked) =>
                      onSelectedRowsChange(checked ? new Set(rows.map((r) => r.id)) : new Set())
                    }
                  />
                )}
              </div>
              {onOpenRow && (
                <div
                  aria-hidden="true"
                  className="sticky z-30 shrink-0 border-r bg-grid-header"
                  style={{ left: gutter, width: openWidth }}
                />
              )}
              {columns.map((column, i) => (
                <HeaderCell
                  column={column}
                  index={i}
                  key={`${column.name}-${i}`}
                  onAutoFit={() => setWidth(i, Math.max(estimateWidth(column, rows, i), 100))}
                  onResize={(w) => setWidth(i, w)}
                  onSort={onSortChange ? (additive) => toggleSort(column.name, additive) : undefined}
                  onSortDirection={
                    onSortChange ? (direction) => onSortChange([{ column: column.name, direction }]) : undefined
                  }
                  onFilter={onFilterColumn ? () => onFilterColumn(column.name) : undefined}
                  onHide={onHideColumn && columns.length > 1 ? () => onHideColumn(i) : undefined}
                  sort={sortMap.get(column.name)}
                  sortCount={sort?.length ?? 0}
                  width={colWidths[i]!}
                />
              ))}
              <div className="flex-1" />
            </div>

            {virtualRows.map((vr) => {
              const row = rows[vr.index]!
              return (
                <GridRowView
                  actions={rowActions}
                  activeCol={active?.row === vr.index ? active.col : -1}
                  canNavigate={Boolean(onNavigateForeignKey)}
                  columns={columns}
                  domId={`${gridId}-s${vr.slot}`}
                  editing={editing?.rowId === row.id ? editing : null}
                  gutter={gutter}
                  index={vr.index}
                  // the row element is recycled: it keeps its slot while the window moves (see useRowVirtualizer)
                  key={vr.slot}
                  openWidth={openWidth}
                  panelOpen={openRowId === row.id}
                  row={row}
                  rowNumber={rowNumberOffset + vr.index + 1}
                  selectable={Boolean(onSelectedRowsChange)}
                  selected={selectedRows?.has(row.id) ?? false}
                  showOpen={Boolean(onOpenRow)}
                  start={vr.start}
                  totalWidth={totalWidth}
                  widths={colWidths}
                />
              )
            })}
          </div>
        </ContextMenuTrigger>

        <ContextMenuPopup className="min-w-52">
          {menuCell ? (
            <>
              <ContextMenuItem onClick={() => copyValue(menuCell.pos)}>
                <CopyIcon aria-hidden="true" />
                Copy value
                <ContextMenuShortcut>{shortcut('C')}</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  const obj = rowToObject(
                    columns,
                    menuCell.row.values.map((v) => (v === undefined || isDefaultMarker(v) ? null : v)),
                  )
                  void copyWithAnchoredToast(
                    JSON.stringify(obj, null, 2),
                    cellElement(menuCell.pos),
                    'Row copied as JSON',
                  )
                }}
              >
                <CopyIcon aria-hidden="true" />
                Copy row as JSON
              </ContextMenuItem>
              {menuCell.selected.length > 0 && (
                <ContextMenuItem onClick={copySelectedRows}>
                  <CopyIcon aria-hidden="true" />
                  Copy {countLabel(menuCell.selected.length, 'selected row')}
                </ContextMenuItem>
              )}
              {onFilter && menuCell.row.status !== 'new' && (
                <>
                  <ContextMenuSeparator />
                  {menuValue === null ? (
                    <ContextMenuItem onClick={() => onFilter(menuCell.column.name, 'is_null')}>
                      <EqualIcon aria-hidden="true" />
                      Filter where {menuCell.column.name} is NULL
                    </ContextMenuItem>
                  ) : (
                    menuValue !== undefined &&
                    !isDefaultMarker(menuValue) && (
                      <>
                        <ContextMenuItem onClick={() => onFilter(menuCell.column.name, 'eq', cellToText(menuValue))}>
                          <EqualIcon aria-hidden="true" />
                          <span className="truncate">Filter by this value</span>
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onFilter(menuCell.column.name, 'neq', cellToText(menuValue))}>
                          <EqualNotIcon aria-hidden="true" />
                          <span className="truncate">Exclude this value</span>
                        </ContextMenuItem>
                      </>
                    )
                  )}
                </>
              )}
              {onSortChange && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onSortChange([{ column: menuCell.column.name, direction: 'asc' }])}>
                    <ArrowUpIcon aria-hidden="true" />
                    Sort ascending
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onSortChange([{ column: menuCell.column.name, direction: 'desc' }])}>
                    <ArrowDownIcon aria-hidden="true" />
                    Sort descending
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              {onOpenRow && (
                <ContextMenuItem onClick={() => onOpenRow(menuCell.row.id)}>
                  {openRowId === menuCell.row.id ? (
                    <PanelRightCloseIcon aria-hidden="true" />
                  ) : (
                    <PanelRightOpenIcon aria-hidden="true" />
                  )}
                  {openRowId === menuCell.row.id ? 'Close row details' : 'Open row details'}
                  <ContextMenuShortcut>Space</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              {menuCell.canEdit && isTemporal(menuCell.column.kind) ? (
                <ContextMenuItem onClick={() => startEdit(menuCell.pos)}>
                  <CalendarIcon aria-hidden="true" />
                  Pick from the calendar
                  <ContextMenuShortcut>{isMac ? '⇧↵' : 'Shift+Enter'}</ContextMenuShortcut>
                </ContextMenuItem>
              ) : (
                <ContextMenuItem
                  onClick={() => setValueDialog({ rowId: menuCell.row.id, col: menuCell.pos.col, value: menuValue })}
                >
                  <Maximize2Icon aria-hidden="true" />
                  {menuCell.canEdit ? 'Edit in large editor' : 'View full value'}
                  <ContextMenuShortcut>{isMac ? '⇧↵' : 'Shift+Enter'}</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              {menuCell.canEdit && (
                <>
                  <ContextMenuItem onClick={() => startEdit(menuCell.pos)}>
                    <PencilIcon aria-hidden="true" />
                    {menuCell.column.kind === 'boolean'
                      ? `Set to ${menuValue === true ? 'false' : 'true'}`
                      : 'Edit cell'}
                    <ContextMenuShortcut>Enter</ContextMenuShortcut>
                  </ContextMenuItem>
                  {menuCell.column.nullable && menuValue !== null && (
                    <ContextMenuItem onClick={() => commit(menuCell.pos, null)}>
                      <CircleSlashIcon aria-hidden="true" />
                      Set NULL
                      <ContextMenuShortcut>Del</ContextMenuShortcut>
                    </ContextMenuItem>
                  )}
                  {menuCell.row.status === 'new' && menuCell.column.hasDefault && (
                    <ContextMenuItem onClick={() => commit(menuCell.pos, { default: true })}>
                      <RotateCcwIcon aria-hidden="true" />
                      Use column default
                    </ContextMenuItem>
                  )}
                </>
              )}
              {fkValue && onNavigateForeignKey && menuCell.column.foreignKey && (
                <ContextMenuItem onClick={() => onNavigateForeignKey(menuCell.column.foreignKey!, fkValue)}>
                  <ArrowUpRightIcon aria-hidden="true" />
                  Open {menuCell.column.foreignKey.table} #{fkValue.length > 16 ? `${fkValue.slice(0, 16)}…` : fkValue}
                </ContextMenuItem>
              )}
              {editable && (onDuplicateRow || onDeleteRows) && (
                <>
                  <ContextMenuSeparator />
                  {onDuplicateRow && menuCell.row.status !== 'deleted' && (
                    <ContextMenuItem onClick={() => onDuplicateRow(menuCell.row.id)}>
                      <CopyPlusIcon aria-hidden="true" />
                      Duplicate row
                      <ContextMenuShortcut>{shortcut('D', { alt: true, shift: true, mod: false })}</ContextMenuShortcut>
                    </ContextMenuItem>
                  )}
                  {onDeleteRows &&
                    (menuCell.row.status === 'deleted' && !(menuSelected && menuCell.selected.length > 1) ? (
                      <ContextMenuItem onClick={() => onDeleteRows([menuCell.row.id])}>
                        <RotateCcwIcon aria-hidden="true" />
                        Restore row
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem
                        onClick={() => onDeleteRows(menuSelected ? menuCell.selected : [menuCell.row.id])}
                        variant="destructive"
                      >
                        <Trash2Icon aria-hidden="true" />
                        {menuSelected && menuCell.selected.length > 1
                          ? `Delete ${countLabel(menuCell.selected.length, 'row')}`
                          : 'Delete row'}
                        <ContextMenuShortcut>{shortcut(isMac ? '⌫' : 'Del')}</ContextMenuShortcut>
                      </ContextMenuItem>
                    ))}
                </>
              )}
            </>
          ) : (
            <ContextMenuItem disabled>No cell selected</ContextMenuItem>
          )}
        </ContextMenuPopup>
      </ContextMenu>

      {rows.length === 0 && emptyState && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center p-6 *:pointer-events-auto"
          style={{ top: HEADER_H }}
        >
          {emptyState}
        </div>
      )}

      <ValueDialog
        column={valueDialog ? (columns[valueDialog.col] ?? null) : null}
        onClose={() => {
          setValueDialog(null)
          requestAnimationFrame(() => scrollRef.current?.focus())
        }}
        onSave={(value) => {
          if (valueDialog) {
            const rowIndex = rows.findIndex((r) => r.id === valueDialog.rowId)
            if (rowIndex >= 0) commit({ row: rowIndex, col: valueDialog.col }, value)
          }
          setValueDialog(null)
          requestAnimationFrame(() => scrollRef.current?.focus())
        }}
        isNew={valueDialog ? rows.find((r) => r.id === valueDialog.rowId)?.status === 'new' : false}
        readOnly={
          !valueDialog ||
          !canEditCell(
            rows.findIndex((r) => r.id === valueDialog.rowId),
            valueDialog.col,
          )
        }
        state={valueDialog}
      />

      {tip && (
        <Tooltip open={tip.open}>
          <TooltipPopup anchor={tip.anchor}>{tip.text}</TooltipPopup>
        </Tooltip>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

function HeaderCell({
  column,
  index,
  width,
  sort,
  sortCount,
  onSort,
  onSortDirection,
  onFilter,
  onHide,
  onResize,
  onAutoFit,
}: {
  column: GridColumn
  index: number
  width: number
  sort?: Sort & { index: number }
  sortCount: number
  onSort?: (additive: boolean) => void
  onSortDirection?: (direction: 'asc' | 'desc') => void
  onFilter?: () => void
  onHide?: () => void
  onResize: (width: number) => void
  onAutoFit: () => void
}) {
  // Ends the drag in progress, if any. Kept so that unmounting mid-drag can end it too.
  const endDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => endDrag.current?.(), [])
  const headerRef = useRef<HTMLDivElement>(null)

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    endDrag.current?.()
    const startX = e.clientX
    const startW = width
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => onResize(startW + ev.clientX - startX)
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      endDrag.current = null
    }
    document.body.style.cursor = 'col-resize'
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    endDrag.current = up
  }

  const title = [
    `${column.name} · ${column.typeName}`,
    column.isPrimaryKey ? 'Primary key' : null,
    column.foreignKey ? `→ ${column.foreignKey.table}.${column.foreignKey.column}` : null,
    column.nullable === false ? 'NOT NULL' : null,
    column.defaultValue ? `default ${column.defaultValue}` : null,
    column.comment,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      aria-colindex={index + 1}
      aria-sort={sort ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn(
        'group/h relative flex shrink-0 items-center gap-1.5 overflow-hidden border-r px-2.5 text-[12.5px]',
        onSort && 'cursor-pointer select-none hover:bg-accent/60',
      )}
      onClick={(e) => onSort?.(e.shiftKey)}
      ref={headerRef}
      role="columnheader"
      style={{ width }}
      title={title}
    >
      {column.isPrimaryKey && <KeyRoundIcon aria-label="Primary key" className="size-3 shrink-0 text-amber-500" />}
      {!column.isPrimaryKey && column.foreignKey && (
        <LinkIcon aria-label="Foreign key" className="size-3 shrink-0 text-blue-500" />
      )}
      <span className="min-w-0 shrink-[0.2] truncate font-medium">{column.name}</span>
      <span className="ms-auto min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/80">
        {column.typeLabel ?? column.typeName}
      </span>
      {/* fixed slot: toggling the sort must not move the type label */}
      <span aria-hidden="true" className="relative flex w-3 shrink-0 items-center justify-center text-foreground">
        {sort && (sort.direction === 'asc' ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
        {sort && sortCount > 1 && (
          <span className="absolute -top-1.5 -right-1.5 font-mono text-[9px] text-muted-foreground">
            {sort.index + 1}
          </span>
        )}
      </span>
      {/* column menu: floats over the end of the header on hover, so nothing moves */}
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={`${column.name} column menu`}
              className="absolute top-1/2 right-2.5 z-10 -translate-y-1/2 bg-grid-header opacity-0 shadow-xs/5 group-hover/h:opacity-100 data-popup-open:opacity-100 sm:size-6"
              onClick={(e) => e.stopPropagation()}
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-48" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
          {onSortDirection && (
            <>
              <MenuItem onClick={() => onSortDirection('asc')}>
                <ArrowUpIcon aria-hidden="true" />
                Sort ascending
              </MenuItem>
              <MenuItem onClick={() => onSortDirection('desc')}>
                <ArrowDownIcon aria-hidden="true" />
                Sort descending
              </MenuItem>
            </>
          )}
          {onFilter && (
            <MenuItem onClick={onFilter}>
              <FilterIcon aria-hidden="true" />
              Filter by {column.name}…
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onClick={() => void copyWithAnchoredToast(column.name, headerRef.current, 'Column name copied')}>
            <CopyIcon aria-hidden="true" />
            Copy column name
          </MenuItem>
          {onHide && (
            <MenuItem onClick={onHide}>
              <EyeOffIcon aria-hidden="true" />
              Hide column
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
      <div
        aria-hidden="true"
        className="absolute top-0 right-0 z-10 h-full w-2 cursor-col-resize after:absolute after:inset-y-1.5 after:right-0 after:w-0.5 after:rounded-full after:bg-transparent hover:after:bg-ring"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onAutoFit()
        }}
        onPointerDown={startResize}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

/**
 * One grid row. Every prop is a primitive, a stable object, or the row's own data, so a row only
 * re-renders when it changes: the active cell moving re-renders the two rows involved, not all of them.
 * Its handlers come in one stable `actions` object (see useStableHandlers).
 */
const GridRowView = memo(function GridRowView({
  actions,
  row,
  index,
  rowNumber,
  columns,
  widths,
  gutter,
  openWidth,
  start,
  totalWidth,
  selectable,
  selected,
  showOpen,
  canNavigate,
  activeCol,
  editing,
  panelOpen,
  domId,
}: {
  actions: RowActions
  row: GridRow
  index: number
  rowNumber: number
  columns: GridColumn[]
  /** the element id; the grid's aria-owns lists these in visual order */
  domId: string
  widths: number[]
  gutter: number
  openWidth: number
  start: number
  totalWidth: number
  selectable: boolean
  selected: boolean
  showOpen: boolean
  canNavigate: boolean
  activeCol: number
  /** set only on the row being edited */
  editing: (Pos & { initial?: string }) | null
  panelOpen: boolean
}) {
  const deleted = row.status === 'deleted'
  const isNew = row.status === 'new'
  return (
    <div
      aria-rowindex={index + 2}
      aria-selected={selected || undefined}
      className={cn(
        'group/row absolute top-0 left-0 flex select-none border-b border-border/70',
        selected ? 'bg-grid-row-selected' : 'bg-background hover:bg-grid-row-hover',
        isNew && 'bg-success/6 hover:bg-success/8',
        deleted &&
          'bg-destructive/6 text-muted-foreground line-through decoration-destructive/60 hover:bg-destructive/8',
      )}
      id={domId}
      role="row"
      style={{ height: ROW_H, transform: `translateY(${start}px)`, width: totalWidth, minWidth: '100%' }}
    >
      <div
        className={cn(
          'sticky left-0 z-10 flex shrink-0 items-center justify-center border-r bg-inherit font-sans text-[11px] text-muted-foreground/70 tabular-nums',
          'bg-background group-hover/row:bg-[color-mix(in_srgb,var(--background),var(--foreground)_2.5%)]',
          selected && 'bg-[color-mix(in_srgb,var(--background),var(--color-blue-500)_7%)]',
        )}
        onDoubleClick={() => actions.onOpenRow(row.id)}
        style={{ width: gutter }}
      >
        {selectable ? (
          <>
            <span className={cn('group-hover/row:hidden', (selected || isNew || deleted) && 'hidden')}>
              {rowNumber}
            </span>
            {isNew && !selected && (
              <span className="font-medium text-success-foreground group-hover/row:hidden">new</span>
            )}
            {deleted && !selected && (
              <Trash2Icon
                aria-label="Marked for deletion"
                className="size-3.5 text-destructive-foreground group-hover/row:hidden"
              />
            )}
            <span
              className={cn('hidden group-hover/row:flex', selected && 'flex')}
              onClick={(e) => {
                e.stopPropagation()
                actions.onToggleSelect(index, e.shiftKey)
              }}
            >
              <Checkbox aria-label={`Select row ${rowNumber}`} checked={selected} />
            </span>
          </>
        ) : (
          rowNumber
        )}
      </div>
      {showOpen && (
        // its own narrow column, so the button never crowds the checkbox; shown on row hover only
        <div
          className={cn(
            'sticky z-10 flex shrink-0 items-center justify-center border-r',
            'bg-background group-hover/row:bg-[color-mix(in_srgb,var(--background),var(--foreground)_2.5%)]',
            selected && 'bg-[color-mix(in_srgb,var(--background),var(--color-blue-500)_7%)]',
          )}
          style={{ left: gutter, width: openWidth }}
        >
          {/* its tooltip is the grid's shared one (data-tip) */}
          <Button
            aria-label={panelOpen ? `Close details of row ${rowNumber}` : `Open row ${rowNumber}`}
            aria-pressed={panelOpen}
            className={cn(
              'transition-opacity',
              panelOpen
                ? 'bg-accent text-foreground opacity-100'
                : 'text-muted-foreground opacity-0 group-hover/row:opacity-100',
            )}
            data-tip={panelOpen ? 'Close row details (Space)' : 'Open row details (Space)'}
            onClick={(e) => {
              e.stopPropagation()
              actions.onOpenRow(row.id)
            }}
            size="icon-xs"
            tabIndex={-1}
            variant="ghost"
          >
            {panelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
          </Button>
        </div>
      )}
      {columns.map((column, col) => {
        const value = row.values[col]
        const isActive = activeCol === col
        const isEditing = editing?.col === col
        const isEdited = row.edited?.has(col)
        const issue = deleted ? undefined : row.issues?.get(col)
        const fk = column.foreignKey && typeof value === 'string' && !isNew ? column.foreignKey : null
        return (
          <div
            aria-colindex={col + 1}
            aria-invalid={issue ? true : undefined}
            aria-selected={isActive || undefined}
            className={cn(
              'relative flex shrink-0 items-center overflow-hidden whitespace-nowrap border-border/70 border-r px-2.5',
              column.kind === 'number' && !column.foreignKey && 'justify-end',
              isActive && column.kind === 'boolean' && !deleted && 'cursor-pointer',
              // an editor may be wider than its cell (a full timestamp)
              isEditing && 'z-[2] overflow-visible',
              isEdited && !deleted && 'bg-warning/12',
              issue && 'bg-destructive/10 shadow-[inset_0_0_0_1px_var(--color-destructive)]',
              isActive && 'z-[1] outline-2 outline-ring -outline-offset-2',
              isActive && issue && 'outline-destructive',
            )}
            title={issue}
            data-cell=""
            data-col={col}
            data-row={index}
            key={col}
            onDoubleClick={() => actions.onCellDoubleClick(index, col)}
            onMouseDown={(e) => {
              if (e.button === 0 || e.button === 2) actions.onCellMouseDown(index, col, e.button)
            }}
            role="gridcell"
            style={{ width: widths[col] }}
          >
            {isEditing ? (
              <InlineEditor
                // keyed by record: a slot can show another row later, and its editor must not keep this row's text
                key={row.id}
                column={column}
                initial={editing!.initial}
                isNew={isNew}
                onCancel={actions.onCancelEdit}
                onCommit={(v, move) => actions.onCommitEdit(index, v, move)}
                onExpand={(draft) => actions.onExpand(index, draft)}
                registerFlush={actions.onEditorFlush}
                value={value}
              />
            ) : (
              <>
                <span className="min-w-0 truncate">
                  <CellContent column={column} value={value} />
                </span>
                {fk && canNavigate && (
                  <Button
                    aria-label={`Open referenced ${fk.table}`}
                    className="absolute top-1/2 right-1 hidden size-5 -translate-y-1/2 group-hover/row:flex sm:size-5 [&_svg]:size-3!"
                    data-tip={`Open ${fk.table} where ${fk.column} = ${value as string}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      actions.onNavigateForeignKey(fk, value as string)
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    size="icon-xs"
                    tabIndex={-1}
                    variant="outline"
                  >
                    <ArrowUpRightIcon />
                  </Button>
                )}
              </>
            )}
          </div>
        )
      })}
      <div className="flex-1" />
    </div>
  )
})

// ---------------------------------------------------------------------------
// inline editor
// ---------------------------------------------------------------------------

function InlineEditor({
  column,
  value,
  initial,
  isNew,
  onCommit,
  onCancel,
  onExpand,
  registerFlush,
}: {
  column: GridColumn
  value: GridValue | undefined
  initial?: string
  isNew: boolean
  onCommit: (value: GridValue, move?: 'down' | 'right') => void
  onCancel: () => void
  /** opens the large editor; carries the typed text when the user changed it */
  onExpand: (draft?: string) => void
  registerFlush: (fn: (() => void) | null) => void
}) {
  const committed = useRef(false)
  const stored = typeof value === 'string' ? value : typeof value === 'boolean' ? String(value) : ''
  // a timestamptz shown in local time is edited in local time too (offset included, so it stays exact)
  const startText =
    initial ??
    (column.kind === 'timestamp' && column.timeDisplay?.timeZone === 'local' && isZoned(column.typeName)
      ? (toLocalTimestamptz(stored) ?? stored)
      : stored)
  const [text, setText] = useState(startText)
  // state, not a ref: the message may be due on the very first render, before a ref is attached
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  // same rules as the row panel and the save: shown while typing, next to the cell
  const problem =
    text === startText && initial === undefined
      ? null
      : validateValue(textToValue(text, column, isNew), columnSpec(column), { isNew })
  const finish = (t: string, move?: 'down' | 'right') => {
    committed.current = true
    // untouched: keep the stored value as it is (not its re-written local form)
    if (initial === undefined && t === startText && value !== undefined) onCommit(value, move)
    else onCommit(textToValue(t, column, isNew), move)
  }
  const selectEditor = column.kind === 'boolean' || (column.kind === 'enum' && Boolean(column.enumValues?.length))
  // the typed text, so the large editor opens with it; undefined while the text is still the stored value
  const draft = initial !== undefined || text !== startText ? text : undefined

  // the grid calls this when the row scrolls out while the editor is open: commit as a blur would
  // (a select has no typed text, so it just closes). Registered on every render so it sees the latest text.
  useLayoutEffect(() => {
    registerFlush(() => {
      if (committed.current) return
      if (selectEditor) {
        committed.current = true
        onCancel()
      } else finish(text)
    })
  })

  if (selectEditor) {
    const options =
      column.kind === 'boolean'
        ? [
            { label: 'true', value: 'true' },
            { label: 'false', value: 'false' },
          ]
        : column.enumValues!.map((v) => ({ label: v, value: v }))
    if (column.nullable) options.push({ label: 'NULL', value: '\u0000null' })
    const current =
      value === null
        ? '\u0000null'
        : typeof value === 'boolean'
          ? String(value)
          : typeof value === 'string'
            ? value
            : null
    return (
      <Select
        defaultOpen
        items={options}
        onOpenChange={(open) => {
          if (!open && !committed.current) onCancel()
        }}
        onValueChange={(v) => {
          committed.current = true
          if (v === '\u0000null') onCommit(null)
          else if (column.kind === 'boolean') onCommit(v === 'true')
          else onCommit(v as string)
        }}
        value={current}
      >
        <SelectTrigger
          className="absolute inset-0 h-full min-h-0 min-w-0 rounded-none border-0 font-mono text-[12.5px] shadow-none ring-2 ring-ring ring-inset before:hidden sm:min-h-0"
          size="sm"
        >
          <SelectValue placeholder="Pick a value" />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((o) => (
            <SelectItem className="font-mono text-[12.5px]" key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    )
  }

  if (column.foreignKey) {
    return (
      <div className="absolute inset-0 flex items-center bg-background ring-2 ring-ring ring-inset">
        <ForeignKeyField
          autoFocus
          className="h-full rounded-none border-0 bg-transparent shadow-none before:hidden *:px-2.5! *:font-mono *:text-[12.5px]! dark:bg-transparent"
          defaultOpen
          fk={column.foreignKey}
          onChange={setText}
          onCommit={(t) => {
            if (!committed.current) finish(t)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              finish(e.currentTarget.value, 'down')
            } else if (e.key === 'Tab') {
              e.preventDefault()
              finish(e.currentTarget.value, 'right')
            } else if (e.key === 'Escape') {
              e.preventDefault()
              committed.current = true
              onCancel()
            }
          }}
          placeholder={value === null ? 'NULL' : `Search ${column.foreignKey.table}…`}
          value={text}
        />
      </div>
    )
  }

  if (isTemporal(column.kind)) {
    return (
      <TemporalCellEditor
        anchor={anchor}
        column={column}
        onCancel={() => {
          if (committed.current) return
          committed.current = true
          onCancel()
        }}
        onExpand={() => {
          committed.current = true
          onExpand(draft)
        }}
        onFinish={(t, move) => {
          if (!committed.current) finish(t, move)
        }}
        placeholder={value === null ? 'NULL' : ''}
        problem={problem}
        selectAll={initial === undefined}
        setAnchor={setAnchor}
        setText={setText}
        text={text}
      />
    )
  }

  return (
    <div
      className={cn(
        'absolute inset-0 flex items-center bg-background ring-2 ring-inset',
        problem ? 'ring-destructive' : 'ring-ring',
      )}
      ref={setAnchor}
    >
      <Input
        aria-invalid={problem ? true : undefined}
        autoFocus
        className="h-full min-w-0 flex-1 *:h-full! *:px-2.5! *:font-mono *:text-[12.5px]! *:leading-none!"
        nativeInput
        onBlur={(e) => {
          if (!committed.current) finish(e.currentTarget.value)
        }}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          if (initial === undefined) e.currentTarget.select()
          else {
            const len = e.currentTarget.value.length
            e.currentTarget.setSelectionRange(len, len)
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if ((e.key === 'Enter' && e.shiftKey) || (e.key === 'ArrowDown' && e.altKey)) {
            e.preventDefault()
            committed.current = true
            onExpand(draft)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            finish(e.currentTarget.value, 'down')
          } else if (e.key === 'Tab') {
            e.preventDefault()
            finish(e.currentTarget.value, 'right')
          } else if (e.key === 'Escape') {
            e.preventDefault()
            committed.current = true
            onCancel()
          }
        }}
        placeholder={value === null ? 'NULL' : ''}
        spellCheck={false}
        unstyled
        value={text}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Open large editor"
              className="me-1 text-muted-foreground"
              onMouseDown={(e) => {
                e.preventDefault()
                committed.current = true
                onExpand(draft)
              }}
              size="icon-xs"
              tabIndex={-1}
              variant="ghost"
            />
          }
        >
          <Maximize2Icon />
        </TooltipTrigger>
        <TooltipPopup>Open large editor (Shift+Enter)</TooltipPopup>
      </Tooltip>
      {/* the message floats under the cell (cells clip their content) */}
      <Popover open={Boolean(problem && anchor)}>
        <PopoverPopup
          anchor={anchor}
          align="start"
          className="max-w-80 px-2.5 py-1.5 text-destructive-foreground text-xs"
          initialFocus={false}
          side="bottom"
          sideOffset={2}
          tooltipStyle
        >
          {problem}
        </PopoverPopup>
      </Popover>
    </div>
  )
}

/**
 * A date/time cell being edited: the text in the cell, a calendar (and time) popover
 * under it. Picking a date of a `date` column finishes; for timestamps "Done", Enter or
 * clicking elsewhere does. Esc cancels.
 */
function TemporalCellEditor({
  column,
  text,
  setText,
  problem,
  anchor,
  setAnchor,
  selectAll,
  placeholder,
  onFinish,
  onCancel,
  onExpand,
}: {
  column: GridColumn
  text: string
  setText: (t: string) => void
  problem: string | null
  anchor: HTMLDivElement | null
  setAnchor: (el: HTMLDivElement | null) => void
  selectAll: boolean
  placeholder: string
  onFinish: (text: string, move?: 'down' | 'right') => void
  onCancel: () => void
  onExpand: () => void
}) {
  const [open, setOpen] = useState(true)
  const latest = useRef(text)
  useLayoutEffect(() => {
    latest.current = text
  }, [text])
  return (
    <div
      className={cn(
        'absolute inset-y-0 left-0 flex items-center bg-background shadow-md/5 ring-2 ring-inset',
        problem ? 'ring-destructive' : 'ring-ring',
      )}
      ref={setAnchor}
      style={{
        width:
          column.kind === 'timestamp' ? 'max(100%, 19.5rem)' : column.kind === 'time' ? 'max(100%, 11rem)' : '100%',
      }}
    >
      <Input
        aria-invalid={problem ? true : undefined}
        autoFocus
        className="h-full min-w-0 flex-1 *:h-full! *:px-2.5! *:font-mono *:text-[12.5px]! *:leading-none!"
        nativeInput
        onBlur={(e) => {
          // with the calendar open, focus may move into it; it finishes on its own
          if (!open) onFinish(e.currentTarget.value)
        }}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          if (selectAll) e.currentTarget.select()
          else {
            const len = e.currentTarget.value.length
            e.currentTarget.setSelectionRange(len, len)
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'ArrowDown' && e.altKey) {
            e.preventDefault()
            setOpen((o) => !o)
          } else if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault()
            onExpand()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            onFinish(e.currentTarget.value, 'down')
          } else if (e.key === 'Tab') {
            e.preventDefault()
            onFinish(e.currentTarget.value, 'right')
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        unstyled
        value={text}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={open ? 'Hide the calendar' : 'Show the calendar'}
              aria-pressed={open}
              className="me-1 text-muted-foreground"
              onClick={() => setOpen((o) => !o)}
              onMouseDown={(e) => e.preventDefault()}
              size="icon-xs"
              tabIndex={-1}
              variant="ghost"
            />
          }
        >
          <CalendarIcon />
        </TooltipTrigger>
        <TooltipPopup>{open ? 'Hide' : 'Show'} the calendar (Alt+↓)</TooltipPopup>
      </Tooltip>
      <Popover
        onOpenChange={(next, details) => {
          if (next) return setOpen(true)
          if (details.reason === 'escape-key') return onCancel()
          // clicks in the cell itself (moving the cursor) keep it open
          const target = details.event?.target
          if (target instanceof Node && anchor?.contains(target)) return
          if (details.reason === 'outside-press' || details.reason === 'focus-out') onFinish(latest.current)
          else setOpen(false)
        }}
        open={open && Boolean(anchor)}
      >
        <PopoverPopup
          align="start"
          anchor={anchor}
          className="w-auto"
          initialFocus={false}
          side="bottom"
          sideOffset={4}
        >
          {problem && <p className="pb-2 text-destructive-foreground text-xs">{problem}</p>}
          <TemporalPicker
            kind={column.kind}
            onDone={() => onFinish(latest.current)}
            onPick={(t) => {
              setText(t)
              latest.current = t
              if (column.kind === 'date') onFinish(t)
            }}
            typeName={column.typeName}
            value={text}
          />
        </PopoverPopup>
      </Popover>
    </div>
  )
}
