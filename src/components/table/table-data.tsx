import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  CircleAlertIcon,
  Columns3Icon,
  FileCodeIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  Trash2Icon,
  Undo2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
import { useDeferredValue, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { applyChangesFn, referenceLabelsFn } from '@/api/explorer.functions'
import { ExportMenu, type WholeTableFormat } from '@/components/app/export-menu'
import { DataGrid, rowNumberGutter } from '@/components/grid/data-grid'
import {
  createIdentityBox,
  createKeyedCache,
  issuesWithServerIssue,
  keepIdentity,
  sameData,
  sameElements,
  storedGridRow,
} from '@/components/grid/stable-rows'
import type { GridColumn, GridRow, GridValue, RefLabel } from '@/components/grid/types'
import { SqlCodeView } from '@/components/sql/codemirror'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Group } from '@/components/ui/group'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { shortcut, useHotkey } from '@/hooks/use-hotkey'
import { useFloatingBar } from '@/hooks/use-floating-bar'
import { useMediaQuery } from '@/hooks/use-media-query'
import { exportRows, toTsv } from '@/lib/export'
import { copyWithToast } from '@/components/app/copy-feedback'
import type { ExportFormat } from '@/lib/export'
import { countLabel, formatCount, formatDuration } from '@/lib/format'
import { useProductionGuard } from '@/lib/production-guard'
import type { ProductionRequest } from '@/lib/production-guard'
import { countQuery, keys, rowsQuery, schemaObjectsQuery } from '@/lib/queries'
import { displayQualified } from '@/lib/sql'
import { useAppStore } from '@/lib/store'
import { isZoned, localZoneName, sameTimestamptz } from '@/lib/time'
import type { Cell, Filter, RelationDetails, RowKey, Sort } from '@/lib/types'
import { cn } from '@/lib/utils'
import { describeFilter, FilterPopover } from './filter-popover'
import { ImportCsvDialog } from './import-csv-dialog'
import { buildChanges, changeRowIds, emptyPending, pendingStats, previewSql, savedRowIndex } from './pending'
import type { PendingChanges } from './pending'
import { LazyRowDrawer, preloadRowDrawer } from './row-drawer-lazy'
import { TableDataSkeleton } from './table-data-skeleton'
import { LookupContext, columnSpec } from '@/components/grid/value-editors'
import type { PendingHistory } from '@/hooks/use-pending-history'
import { validateValue } from '@/lib/validate'
import { countParams, rowsParams } from '@/lib/table-search'

export interface TableSearch {
  tab?: 'data' | 'structure' | 'ddl'
  page?: number
  size?: number
  sort?: Sort[]
  filters?: Filter[]
  where?: string
  q?: string
}

const PAGE_SIZES = [50, 100, 250, 500, 1000]

interface SaveError {
  message: string
  detail: string
  /** row the failed change belongs to, and the columns PostgreSQL blamed */
  rowId?: string
  cols: number[]
}

/** Plain-language message for the usual constraint errors (the original stays in the details). */
function friendlyConstraintError(e: { code?: string; message: string; detail?: string; constraint?: string }): string {
  const detail = e.detail ?? ''
  switch (e.code) {
    case '23503': {
      const missing = /^Key \((.+?)\)=\((.*)\) is not present in table "(.+?)"/.exec(detail)
      if (missing) return `No ${missing[3]} row has ${missing[1]} = ${missing[2]}`
      const used = /^Key \((.+?)\)=\((.*)\) is still referenced from table "(.+?)"/.exec(detail)
      if (used) return `Rows in ${used[3]} still use it. Change or delete those rows first`
      return e.message
    }
    case '23505': {
      const dup = /^Key \((.+?)\)=\((.*)\) already exists/.exec(detail)
      return dup ? `${dup[2]} is already taken. Each ${dup[1]} must be unique` : e.message
    }
    case '23502':
      return 'Cannot be NULL'
    case '23514':
      return e.constraint ? `Breaks the rule "${e.constraint}"` : e.message
    default:
      return e.message
  }
}

class SaveFailure extends Error {
  constructor(readonly info: SaveError) {
    super(info.message)
  }
}

export function TableData({
  connectionId,
  database,
  schema,
  table,
  details,
  readOnly,
  search,
  onSearchChange,
  pending,
  setPending,
  history,
}: {
  connectionId: string
  database: string
  schema: string
  table: string
  details: RelationDetails | undefined
  readOnly: boolean
  search: TableSearch
  onSearchChange: (patch: Partial<TableSearch>) => void
  pending: PendingChanges
  setPending: (updater: (p: PendingChanges) => PendingChanges) => void
  history: Pick<PendingHistory, 'undo' | 'redo' | 'reset' | 'canUndo' | 'canRedo'>
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  const defaultPageSize = useAppStore((s) => s.pageSize)
  const setDefaultPageSize = useAppStore((s) => s.setPageSize)
  const timeZoneMode = useAppStore((s) => s.timeZoneMode)
  const setTimeZoneMode = useAppStore((s) => s.setTimeZoneMode)
  const showFraction = useAppStore((s) => s.showFractionalSeconds)
  const setShowFraction = useAppStore((s) => s.setShowFractionalSeconds)
  const viewKey = `${connectionId}:${database}:${schema}.${table}`
  const hiddenNames = useAppStore((s) => s.hiddenColumns[viewKey])
  const setHiddenColumns = useAppStore((s) => s.setHiddenColumns)
  // wide screens: the row panel sits next to the grid; narrow ones: a drawer over it
  const docked = useMediaQuery('lg')
  const openRowOnClick = useAppStore((s) => s.openRowOnClick)

  // the same params the route loader prefetches with (see the table route)
  const params = rowsParams(search, defaultPageSize)
  const { page, pageSize, sort, filters } = params

  const rowsQ = useQuery(rowsQuery(connectionId, database, schema, table, params))
  const countQ = useQuery(countQuery(connectionId, database, schema, table, countParams(search)))

  const [selected, setSelected] = useState<Set<string>>(new Set())
  // the columns and rows the grid is memoized on keep their identity while their content is the same
  // (the compiler does not memoize these computed values, so they are rebuilt on each render)
  const [columnsBox] = useState(createIdentityBox<GridColumn[]>)
  const [rowsBox] = useState(createIdentityBox<GridRow[]>)
  const [gridColumnsBox] = useState(createIdentityBox<GridColumn[]>)
  const [gridRowsBox] = useState(createIdentityBox<GridRow[]>)
  const [drawerRowId, setDrawerRowId] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterStart, setFilterStart] = useState<{ name: string; add?: boolean } | null>(null)
  // where the grid's active cell is (the row panel follows it; the filter starts on its column)
  const activeCell = useRef<{ rowId: string; col: number } | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [previewText, setPreviewText] = useState('')
  // A failed save is shown in the changes bar (and the review dialog) until the
  // changes are edited or saved again, instead of a toast that disappears.
  const [saveError, setSaveError] = useState<SaveError | null>(null)
  // jump the grid to a cell (first invalid value, the row a save failed on, …)
  const [jumpTo, setJumpTo] = useState<{ rowId: string; col: number; key: number } | null>(null)
  // ids of new rows: a counter for this mount (the pending changes live only as long as the mount)
  const newRowSeq = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  // empty required fields of new rows are only flagged once a save was attempted
  const [revealRequired, setRevealRequired] = useState(false)
  const [previewError, setPreviewError] = useState<SaveError | null>(null)
  const [searchText, setSearchText] = useState(search.q ?? '')
  // the search box follows the query when it changes from outside (back, another link)
  const [prevSearchQ, setPrevSearchQ] = useState(search.q)
  if (search.q !== prevSearchQ) {
    setPrevSearchQ(search.q)
    setSearchText(search.q ?? '')
  }
  const [prevRowsData, setPrevRowsData] = useState(rowsQ.data)
  if (rowsQ.data !== prevRowsData) {
    setPrevRowsData(rowsQ.data)
    setSelected(new Set())
  }

  const debounceSearch = useEffectEvent(() => {
    if ((search.q ?? '') === searchText) return
    const t = setTimeout(() => onSearchChange({ q: searchText || undefined, page: undefined }), 350)
    return () => clearTimeout(t)
  })
  useEffect(() => debounceSearch(), [searchText])

  const result = rowsQ.data
  const editable = Boolean(details?.editable) && !readOnly

  // ---- foreign key labels ----------------------------------------------------
  // the referenced rows' readable labels for the keys on screen (staged values included)
  const fkColumns = (() => {
    if (!result || !details) return []
    const byName = new Map(details.columns.map((c) => [c.name, c]))
    return result.fields.flatMap((f, index) => {
      const fk = byName.get(f.name)?.foreignKey
      if (!fk) return []
      const values = new Set<string>()
      for (const r of result.rows) if (typeof r[index] === 'string') values.add(r[index] as string)
      for (const e of pending.edits.values()) if (typeof e.get(index) === 'string') values.add(e.get(index) as string)
      for (const ins of pending.inserts)
        if (typeof ins.values.get(index) === 'string') values.add(ins.values.get(index) as string)
      return [{ name: f.name, fk, values: [...values].sort() }]
    })
  })()
  // the fetched labels, one per foreign key column. `combine` keeps this array's identity
  // while the data is unchanged (the query results are structurally shared), so refLabels
  // and the columns built from it stay stable between renders.
  const labelData = useQueries({
    queries: fkColumns.map(({ fk, values }) => ({
      queryKey: [...keys.relation(connectionId, database, fk.schema, fk.table), 'labels', fk.column, values],
      queryFn: () => referenceLabelsFn({ data: { connectionId, database, ...fk, values: values.slice(0, 1000) } }),
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      enabled: values.length > 0,
    })),
    combine: (results) => results.map((q) => q.data),
  })
  const refLabels = (() => {
    const out = new Map<string, Map<string, RefLabel>>()
    fkColumns.forEach((c, i) => {
      const data = labelData[i]
      if (data?.labelColumn)
        out.set(c.name, new Map(data.items.map((it) => [it.value, { label: it.label, detail: it.detail }])))
    })
    return out
  })()

  // ---- columns ------------------------------------------------------------
  const zone = localZoneName()
  const columnsNow: GridColumn[] = (() => {
    if (!result) return []
    const byName = new Map(details?.columns.map((c) => [c.name, c]) ?? [])
    return result.fields.map((f) => {
      const c = byName.get(f.name)
      const kind = c?.kind ?? f.kind
      const typeName = c?.udtName ?? f.typeName
      return {
        name: f.name,
        typeName,
        fullType: c?.type ?? null,
        kind,
        isPrimaryKey: c?.isPrimaryKey,
        foreignKey: c?.foreignKey ?? null,
        nullable: c?.nullable ?? true,
        enumValues: c?.enumValues ?? null,
        readOnly: c ? c.identity === 'a' || c.generated !== '' : false,
        hasDefault: Boolean(c?.defaultValue) || Boolean(c?.identity),
        defaultValue: c?.defaultValue ?? (c?.identity ? 'identity' : null),
        comment: c?.comment ?? null,
        refLabels: refLabels.get(f.name),
        timeDisplay:
          kind === 'timestamp' || kind === 'time' ? { timeZone: timeZoneMode, fraction: showFraction } : undefined,
        typeLabel:
          kind === 'timestamp' && timeZoneMode === 'local' && isZoned(typeName) ? `${typeName} · ${zone}` : undefined,
      }
    })
  })()
  const columns = keepIdentity(columnsBox, columnsNow, sameData)

  const fieldNames = result?.fields.map((f) => f.name) ?? []

  // ---- row identity -------------------------------------------------------
  const pkIndexes = (() => {
    if (!details || details.rowIdentity !== 'pk') return null
    const idx = details.primaryKey.map((k) => fieldNames.indexOf(k))
    return idx.every((i) => i >= 0) ? idx : null
  })()

  const baseIds = (() => {
    if (!result) return []
    // no key (a view): the row is identified by its values, so a sort that moves it keeps the
    // row panel on it; identical rows are told apart by their order
    const seen = new Map<string, number>()
    return result.rows.map((r, i) => {
      if (pkIndexes) return `pk:${JSON.stringify(pkIndexes.map((k) => r[k]))}`
      if (result.ctids) return `ctid:${result.ctids[i]}`
      const text = JSON.stringify(r)
      const n = seen.get(text) ?? 0
      seen.set(text, n + 1)
      return `row:${text}#${n}`
    })
  })()

  const indexById = new Map(baseIds.map((id, i) => [id, i]))

  const keyFor = (rowId: string): RowKey | null => {
    const i = indexById.get(rowId)
    if (i === undefined || !result) return null
    if (pkIndexes && details) {
      const key: RowKey = {}
      details.primaryKey.forEach((k, j) => {
        key[k] = result.rows[i]![pkIndexes[j]!] ?? null
      })
      return key
    }
    if (result.ctids) return { ctid: result.ctids[i]! }
    return null
  }

  // ---- display rows -------------------------------------------------------
  const specs = columns.map(columnSpec)
  const lookup = { connectionId, database }
  // One object per row, kept while that row's data does not change: the grid re-renders only the
  // rows that changed (editing one cell re-renders one row, not the page).
  const [rowCache] = useState(createKeyedCache)
  const [gridRowCache] = useState(createKeyedCache)
  const { rows: rowsNow, hiddenRequired } = (() => {
    const hiddenRequired: { rowId: string; col: number; message: string }[] = []
    if (!result) {
      rowCache.retain(new Set())
      return { rows: [] as GridRow[], hiddenRequired }
    }
    // the same checks as the editors: every staged value is validated before it can be saved
    // (new rows are new as a whole, so their cells are not marked as edited one by one)
    const fresh: GridRow[] = pending.inserts.map((ins) => {
      const values = columns.map((_, c) => ins.values.get(c))
      const issues = new Map<number, string>()
      values.forEach((v, c) => {
        const problem = validateValue(v, specs[c]!, { isNew: true })
        if (problem) issues.set(c, problem)
      })
      const untouchedRequired = [...issues].filter(([c, p]) => p === 'Required' && !ins.values.has(c)).map(([c]) => c)
      if (untouchedRequired.length) {
        hiddenRequired.push(...untouchedRequired.map((col) => ({ rowId: ins.id, col, message: 'Required' })))
        if (!revealRequired) for (const c of untouchedRequired) issues.delete(c)
      }
      const serverIssue = saveError?.rowId === ins.id ? saveError : undefined
      const finalIssues = issuesWithServerIssue(issues, serverIssue)
      return rowCache.get<GridRow>(ins.id, [ins, columns, revealRequired, serverIssue], () => ({
        id: ins.id,
        values,
        status: 'new',
        issues: finalIssues,
      }))
    })
    const base: GridRow[] = result.rows.map((values, i) => {
      const id = baseIds[i]!
      return storedGridRow(
        rowCache,
        {
          id,
          values,
          edits: pending.edits.get(id),
          deleted: pending.deletes.has(id),
          serverIssue: saveError?.rowId === id ? saveError : undefined,
        },
        columns,
        (v, c) => validateValue(v, specs[c]!),
      )
    })
    const all = [...fresh, ...base]
    rowCache.retain(new Set(all.map((r) => r.id)))
    return { rows: all, hiddenRequired }
  })()
  const rows = keepIdentity(rowsBox, rowsNow, sameElements)

  // ---- hidden columns -------------------------------------------------------------
  // The grid gets the visible columns only; its column indexes are mapped back to the
  // table's (which everything else, staged changes and saving, is based on).
  const hiddenSet = new Set(hiddenNames ?? [])
  const visible = columns.map((_, i) => i).filter((i) => !hiddenSet.has(columns[i]!.name))
  const remapped = visible.length !== columns.length
  const toVisible = new Map(visible.map((orig, v) => [orig, v]))
  const toOriginal = (v: number) => (remapped ? (visible[v] ?? v) : v)
  const gridColumns = keepIdentity(gridColumnsBox, remapped ? visible.map((i) => columns[i]!) : columns, sameElements)
  const gridRowsNow = (() => {
    if (!remapped) {
      gridRowCache.retain(new Set())
      return rows
    }
    gridRowCache.retain(new Set(rows.map((r) => r.id)))
    return rows.map((r) =>
      gridRowCache.get<GridRow>(r.id, [r, columns, hiddenNames], () => ({
        ...r,
        values: visible.map((i) => r.values[i]),
        edited: r.edited && new Set([...r.edited].filter((c) => toVisible.has(c)).map((c) => toVisible.get(c)!)),
        issues:
          r.issues &&
          new Map(
            [...r.issues].filter(([c]) => toVisible.has(c)).map(([c, m]): [number, string] => [toVisible.get(c)!, m]),
          ),
      })),
    )
  })()
  const gridRows = keepIdentity(gridRowsBox, gridRowsNow, sameElements)

  // staged values that would be rejected: saving waits until they are fixed
  const invalid = (() => {
    const out: { rowId: string; col: number; message: string }[] = []
    for (const r of rows) {
      if (r.status === 'deleted' || !r.issues) continue
      for (const [col, message] of r.issues)
        if (!(saveError?.rowId === r.id && saveError.cols.includes(col))) out.push({ rowId: r.id, col, message })
    }
    if (!revealRequired) out.push(...hiddenRequired)
    return out
  })()

  const stats = pendingStats(pending, keyFor)
  const dirty = stats.total > 0
  // the floating bars below (rendered when these are true) mark the page so the toasts rise above them
  useFloatingBar('pending', dirty)
  useFloatingBar('selection', selected.size > 0)
  if (!dirty && revealRequired) setRevealRequired(false)
  const pendingSummary = [
    stats.edited && `${stats.edited} edited`,
    stats.inserted && `${stats.inserted} new`,
    stats.deleted && `${stats.deleted} deleted`,
  ]
    .filter(Boolean)
    .join(' · ')

  // ---- editing callbacks ------------------------------------------------------
  /** Stages one cell: a value of a new row, or an edit of a stored row (dropped when it is the original). */
  const stageCell = (p: PendingChanges, rowId: string, col: number, value: GridValue): PendingChanges => {
    if (rowId.startsWith('new:')) {
      return {
        ...p,
        inserts: p.inserts.map((ins) =>
          ins.id === rowId ? { ...ins, values: new Map(ins.values).set(col, value) } : ins,
        ),
      }
    }
    const i = indexById.get(rowId)
    if (i === undefined || !result) return p
    const original = result.rows[i]![col]
    const rowEdits = new Map(p.edits.get(rowId) ?? [])
    if (isOriginal(value, original, columns[col])) rowEdits.delete(col)
    else rowEdits.set(col, value as Cell)
    const edits = new Map(p.edits)
    if (rowEdits.size) edits.set(rowId, rowEdits)
    else edits.delete(rowId)
    return { ...p, edits }
  }
  const onCellChange = (rowId: string, col: number, value: GridValue) =>
    setPending((p) => stageCell(p, rowId, col, value))
  /** Many cells at once (paste), as one undo step. */
  const onCellsChange = (changes: { rowId: string; col: number; value: GridValue }[]) =>
    setPending((p) => changes.reduce((next, c) => stageCell(next, c.rowId, c.col, c.value), p))

  const addRow = (values?: Map<number, GridValue>) => {
    newRowSeq.current += 1
    const id = `new:${newRowSeq.current}`
    setPending((p) => ({ ...p, inserts: [{ id, values: values ?? new Map() }, ...p.inserts] }))
    setDrawerRowId(id)
  }

  const onDuplicateRow = (rowId: string) => {
    const row = rows.find((r) => r.id === rowId)
    if (!row) return
    const values = new Map<number, GridValue>()
    columns.forEach((c, i) => {
      const skip = c.isPrimaryKey || c.readOnly || /nextval\(|gen_random_uuid|uuid_generate/.test(c.defaultValue ?? '')
      const v = row.values[i]
      if (!skip && v !== undefined) values.set(i, v)
    })
    addRow(values)
  }

  const onDeleteRows = (ids: string[]) => {
    setPending((p) => {
      const newIds = new Set(ids.filter((id) => id.startsWith('new:')))
      const existing = ids.filter((id) => !id.startsWith('new:'))
      const deletes = new Set(p.deletes)
      const allDeleted = existing.length > 0 && existing.every((id) => deletes.has(id))
      for (const id of existing) {
        if (allDeleted) deletes.delete(id)
        else deletes.add(id)
      }
      return { ...p, deletes, inserts: p.inserts.filter((ins) => !newIds.has(ins.id)) }
    })
    setSelected(new Set())
  }

  // the new rows of the last save, to find each one again among the refreshed rows
  const savedNewRows = useRef<PendingChanges['inserts']>([])
  // After saving, keep showing the staged edits until the refreshed rows are on
  // screen, then drop them in the same frame (no flash of the old values).
  const clearOnNextData = useRef(false)
  const resetHistory = history.reset
  useLayoutEffect(() => {
    if (clearOnNextData.current) {
      clearOnNextData.current = false
      resetHistory()
    }
  }, [rowsQ.data, resetHistory])

  // staged changes changed: a save error for the earlier ones no longer applies
  const [prevPending, setPrevPending] = useState(pending)
  if (pending !== prevPending) {
    setPrevPending(pending)
    if (saveError) setSaveError(null)
  }

  // a jump to a hidden column shows that column again (runs on each new jump key)
  const unhideJumpColumn = useEffectEvent(() => {
    const name = jumpTo ? columns[jumpTo.col]?.name : undefined
    if (name && hiddenSet.has(name))
      setHiddenColumns(
        viewKey,
        [...hiddenSet].filter((n) => n !== name),
      )
  })
  useEffect(() => unhideJumpColumn(), [jumpTo?.key])
  const gridJumpTo = jumpTo ? { ...jumpTo, col: toVisible.get(jumpTo.col) ?? 0 } : null

  const saveMutation = useMutation({
    onMutate: () => setSaveError(null),
    mutationFn: async () => {
      savedNewRows.current = pending.inserts
      const changes = buildChanges(schema, table, pending, fieldNames, keyFor)
      const res = await applyChangesFn({ data: { connectionId, database, ...changes } })
      if (!res.ok) {
        const e = res.error
        // point the error at the row (and, when PostgreSQL says which, the columns) it is about
        const rowId = e?.failed ? changeRowIds(pending, keyFor)[e.failed.kind][e.failed.index] : undefined
        const keyCols = /^Key \((.+?)\)=/
          .exec(e?.detail ?? '')?.[1]
          ?.split(',')
          .map((c) => c.trim().replace(/^"|"$/g, ''))
        const names = e?.column
          ? [e.column]
          : ((e?.constraint ? details?.constraints.find((c) => c.name === e.constraint)?.columns : undefined) ??
            keyCols ??
            [])
        let cols = names.map((n) => fieldNames.indexOf(n)).filter((c) => c >= 0)
        if (!cols.length && rowId && e?.failed?.kind === 'update') cols = [...(pending.edits.get(rowId)?.keys() ?? [])]
        throw new SaveFailure({
          message: e ? friendlyConstraintError(e) : 'Saving failed',
          detail: [e?.message, e?.detail, e?.hint && `Hint: ${e.hint}`].filter(Boolean).join('\n'),
          rowId,
          cols,
        })
      }
      clearOnNextData.current = true
      await queryClient.invalidateQueries({ queryKey: keys.relation(connectionId, database, schema, table) })
      return res
    },
    onSuccess: (res) => {
      // refreshed data identical to before (e.g. an insert outside this page)
      if (clearOnNextData.current) {
        clearOnNextData.current = false
        history.reset()
      }
      const parts = [
        res.updated && `${res.updated} updated`,
        res.inserted && `${res.inserted} inserted`,
        res.deleted && `${res.deleted} deleted`,
      ].filter(Boolean)
      toastManager.add({ type: 'success', title: 'Changes saved', description: parts.join(' · ') })
      void queryClient.invalidateQueries({ queryKey: [...keys.db(connectionId, database), 'objects'] })
    },
    onError: (err) => {
      const info = err instanceof SaveFailure ? err.info : { message: err.message, detail: '', cols: [] }
      setSaveError(info)
      if (info.rowId) setJumpTo({ rowId: info.rowId, col: info.cols[0] ?? 0, key: Date.now() })
    },
  })

  /** What a save will do, for the production check. More than 10 deleted rows is destructive. */
  const saveRequest = (): ProductionRequest => {
    const parts: string[] = []
    if (stats.edited) parts.push(`save changes to ${countLabel(stats.edited, 'row')}`)
    if (stats.inserted) parts.push(`add ${countLabel(stats.inserted, 'row')}`)
    if (stats.deleted) parts.push(`delete ${countLabel(stats.deleted, 'row')}`)
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('')
    return {
      action: `${list.charAt(0).toUpperCase()}${list.slice(1)} in ${displayQualified(schema, table)}`,
      sql: previewSql(buildChanges(schema, table, pending, fieldNames, keyFor)),
      destructive: stats.deleted > 10,
      confirmLabel: 'Save on production',
    }
  }

  /** Save, unless some staged value would be rejected (then show the first one instead). */
  const save = () => {
    if (saveMutation.isPending) return
    const first = invalid[0]
    if (first) {
      setRevealRequired(true)
      // a counter, not the clock: the grid only reacts to a changed key
      setJumpTo((prev) => ({ rowId: first.rowId, col: first.col, key: (prev?.key ?? 0) + 1 }))
      return
    }
    // on a production connection this waits for the user; a cancel keeps the staged changes
    void guard(saveRequest()).then((ok) => {
      if (ok) saveMutation.mutate()
    })
  }

  // A field of the row panel commits on blur: blur it first, save once that change is in.
  // starts empty: the layout effect below sets it on the first commit, before any save can be requested
  const saveRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    saveRef.current = () => {
      if (dirty) save()
      else
        toastManager.add({ type: 'info', title: 'Nothing to save', description: 'This table has no unsaved changes.' })
    }
  })
  const saveSoon = () => {
    const el = document.activeElement
    const inPanel = el instanceof HTMLElement && el.closest('[aria-label="Row details"], [data-slot="drawer-popup"]')
    if (inPanel) el.blur()
    requestAnimationFrame(() => {
      saveRef.current?.()
      if (inPanel) el.focus() // keep typing where you were
    })
  }

  const discard = () => {
    const summary = pendingSummary
    setPending(() => emptyPending())
    toastManager.add({
      title: 'Changes discarded',
      description: summary,
      actionProps: { children: 'Undo', onClick: () => history.undo() },
      timeout: 8000,
    })
  }

  // ---- shortcuts ------------------------------------------------------------------
  // A refresh that finds no change looks like nothing happened, so it reports back.
  const refreshRows = () => {
    void Promise.all([rowsQ.refetch(), countQ.refetch()]).then(([rows, count]) => {
      const failed = rows.error ?? count.error
      if (failed) toastManager.add({ type: 'error', title: 'Could not refresh', description: failed.message })
      else toastManager.add({ type: 'success', title: 'Data refreshed', timeout: 1500 })
    })
  }
  // always on in a table (a value being typed in the row panel is not staged until it is committed)
  useHotkey('mod+s', saveSoon, { allowInInputs: true })
  useHotkey('mod+z', () => history.undo(), { skipInInputs: true, enabled: history.canUndo })
  useHotkey('mod+shift+z', () => history.redo(), { skipInInputs: true, enabled: history.canRedo })
  useHotkey('mod+y', () => history.redo(), { skipInInputs: true, enabled: history.canRedo })
  useHotkey('mod+f', () => searchRef.current?.focus(), { allowInInputs: true })
  useHotkey('alt+shift+n', () => editable && addRow(), { allowInInputs: true, enabled: editable })
  useHotkey('alt+shift+r', refreshRows, { allowInInputs: true })

  // ---- navigation helpers ---------------------------------------------------------
  const onNavigateForeignKey = (fk: { schema: string; table: string; column: string }, value: string) => {
    void navigate({
      to: '/c/$connId/$db/t/$schema/$table',
      params: { connId: connectionId, db: database, schema: fk.schema, table: fk.table },
      search: { filters: [{ column: fk.column, op: 'eq', value }] },
    })
  }

  const onFilter = (column: string, op: Filter['op'], value?: string) => {
    const next = [...filters.filter((f) => !(f.column === column && f.op === op)), { column, op, value }]
    onSearchChange({ filters: next, page: undefined })
  }

  const drawerOpen = drawerRowId !== null
  const onActiveCellChange = (pos: { rowId: string; col: number } | null) => {
    activeCell.current = pos
    // an open side panel shows the row being worked on in the grid (and opens on click, if set so)
    if (pos && docked && (drawerOpen || openRowOnClick)) setDrawerRowId(pos.rowId)
  }
  // the row's panel icon, Space and the menu open the details, and close them again for the same row
  const toggleRowPanel = (id: string) => setDrawerRowId((cur) => (cur === id ? null : id))

  const drawerIndex = drawerRowId ? rows.findIndex((r) => r.id === drawerRowId) : -1
  // switching rows in an open panel is deferred, so the grid cursor never waits for the panel to rebuild;
  // opening and closing stay immediate
  const deferredDrawerRowId = useDeferredValue(drawerRowId)
  const panelRowId = drawerRowId === null || deferredDrawerRowId === null ? drawerRowId : deferredDrawerRowId
  const panelIndex =
    panelRowId === drawerRowId ? drawerIndex : panelRowId ? rows.findIndex((r) => r.id === panelRowId) : -1
  const panelRow = panelIndex >= 0 ? rows[panelIndex]! : null
  // The panel shows a row of the grid. Once it is not there any more, follow it or close:
  // a new row that was saved is now the stored row with its primary key (its temporary id
  // is gone); any other row left the result (page, filter, sort, search) and closes the panel.
  useEffect(() => {
    if (drawerRowId === null || drawerIndex >= 0 || !result) return
    const staged = drawerRowId.startsWith('new:')
      ? savedNewRows.current.find((ins) => ins.id === drawerRowId)
      : undefined
    const i = staged && pkIndexes ? savedRowIndex(staged.values, pkIndexes, result.rows) : -1
    setDrawerRowId(i >= 0 ? baseIds[i]! : null)
  }, [drawerRowId, drawerIndex, result, pkIndexes, baseIds])

  // the drawer's code is fetched while the browser is idle, so the first open is instant
  useEffect(() => {
    const warm = () => {
      preloadRowDrawer().catch(() => {
        // a failed warm-up is harmless: opening the drawer loads it again and reports the error then
      })
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm)
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(warm, 1500)
    return () => window.clearTimeout(timer)
  }, [])

  // ---- counts -----------------------------------------------------------------
  const start = (page - 1) * pageSize
  const shown = result?.rows.length ?? 0
  const total = countQ.data?.count
  // Size of the whole table rather than of the current page or filter result: the
  // row-number column and the range label are sized for it, so neither changes width
  // (and shifts the grid sideways) while paging or filtering.
  const rowCountHint = Math.max(details?.estimatedRows ?? 0, total ?? 0, start + shown)
  const widestCount = formatCount(rowCountHint)
  const totalPages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null
  const hasNext = result?.hasMore ?? false

  const rowPanel = (
    <LazyRowDrawer
      columns={columns}
      docked={docked}
      editable={editable}
      onChange={(col, value) => panelRow && onCellChange(panelRow.id, col, value)}
      onClose={() => setDrawerRowId(null)}
      onToggleDelete={
        panelRow
          ? () => {
              onDeleteRows([panelRow.id])
              if (panelRow.status === 'new') setDrawerRowId(null) // a discarded new row is gone
            }
          : undefined
      }
      onNavigateForeignKey={(fk, v) => {
        setDrawerRowId(null)
        onNavigateForeignKey(fk, v)
      }}
      onNext={
        panelIndex >= 0 && panelIndex < rows.length - 1 ? () => setDrawerRowId(rows[panelIndex + 1]!.id) : undefined
      }
      onPrev={panelIndex > 0 ? () => setDrawerRowId(rows[panelIndex - 1]!.id) : undefined}
      original={panelRow && panelRow.status !== 'new' ? result?.rows[indexById.get(panelRow.id) ?? -1] : undefined}
      position={
        panelRow && panelRow.status !== 'new'
          ? `Row ${formatCount(start + panelIndex - pending.inserts.length + 1)}${total != null ? ` of ${formatCount(total)}` : ''}`
          : undefined
      }
      row={panelRow}
      save={{
        summary: pendingSummary,
        problem: invalid.length
          ? `${columns[invalid[0]!.col]?.name}: ${invalid[0]!.message}`
          : saveError
            ? `Not saved: ${saveError.message}`
            : null,
        saving: saveMutation.isPending,
        onSave: saveSoon,
      }}
      title={panelRow?.status === 'new' ? 'New row' : `${table} row`}
    />
  )

  const exportData = (format: ExportFormat | 'copy') => {
    if (!result) return
    const fields = result.fields.map((f, i) => ({ name: f.name, kind: columns[i]?.kind ?? f.kind }))
    if (format === 'copy') {
      void copyWithToast(
        toTsv(fields, result.rows),
        `Copied ${countLabel(result.rows.length, 'row')}`,
        'Ready to paste into any spreadsheet.',
      )
      return
    }
    exportRows(format, table, displayQualified(schema, table), fields, result.rows)
  }

  // Whole table: the server streams every row that matches the grid's filters, search and sort.
  // A hidden link lets the browser run the download itself, so nothing is buffered here.
  const exportWholeTable = (format: WholeTableFormat) => {
    const params = new URLSearchParams({ connection: connectionId, database, schema, table, format })
    if (filters.length) params.set('filters', JSON.stringify(filters))
    if (search.where?.trim()) params.set('where', search.where)
    if (search.q?.trim()) params.set('q', search.q)
    if (sort.length) params.set('sort', JSON.stringify(sort))
    const link = document.createElement('a')
    link.href = `/api/export/table?${params.toString()}`
    link.download = ''
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    const estimate =
      total == null
        ? 'The file downloads as the rows are read.'
        : `${countQ.data?.exact === false ? 'About ' : ''}${countLabel(total, 'row')}${hasFilters ? ' match this view' : ''}`
    toastManager.add({ title: 'Export started', description: estimate })
  }

  // a filter chip opens the filter without a start column (not the one of an earlier cell or header)
  const openFilterFromChip = () => {
    setFilterStart(null)
    setFilterOpen(true)
  }
  const openFilter = (column?: string) => {
    const name = column ?? (activeCell.current ? columns[activeCell.current.col]?.name : undefined)
    setFilterStart(name ? { name, add: Boolean(column) } : null)
    setFilterOpen(true)
  }

  const filterColumns = (details?.columns ?? []).map((c) => ({
    name: c.name,
    kind: c.kind,
    typeName: c.udtName,
    enumValues: c.enumValues,
  }))
  const hasFilters = filters.length > 0 || Boolean(search.where) || Boolean(search.q)

  // Column widths, types, key icons and the "Add row" button all depend on the
  // table metadata; render the view once both rows and metadata are here so
  // nothing jumps after the first paint.
  if (!rowsQ.error && !(result && details)) {
    // the sidebar usually has the table's row estimate already, so the skeleton's row-number
    // column gets the width the grid will use
    const listed = queryClient
      .getQueryData(schemaObjectsQuery(connectionId, database, schema).queryKey)
      ?.relations.find((r) => r.name === table)
    return <TableDataSkeleton gutter={rowNumberGutter(Math.max(rowCountHint, listed?.estimatedRows ?? 0))} />
  }

  return (
    <LookupContext.Provider value={lookup}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <InputGroup className="w-full sm:w-60">
            <InputGroupInput
              aria-label="Search rows"
              ref={searchRef}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchText('')
              }}
              placeholder={`Search rows… (${shortcut('F')})`}
              size="sm"
              value={searchText}
            />
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            {searchText && (
              <InputGroupAddon align="inline-end">
                <Button aria-label="Clear search" onClick={() => setSearchText('')} size="icon-xs" variant="ghost">
                  <XIcon />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
          <FilterPopover
            columns={filterColumns}
            filters={filters}
            onApply={(f, w) => onSearchChange({ filters: f.length ? f : undefined, where: w, page: undefined })}
            onOpenChange={(open) => (open ? openFilter() : setFilterOpen(false))}
            open={filterOpen}
            startColumn={filterStart}
            where={search.where}
          />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {filters.map((f, i) => (
              <FilterChip
                key={`${f.column}-${f.op}-${i}`}
                label={describeFilter(f)}
                onClick={openFilterFromChip}
                onRemove={() => onSearchChange({ filters: filters.filter((_, j) => j !== i), page: undefined })}
              />
            ))}
            {search.where && (
              <FilterChip
                label={`WHERE ${search.where}`}
                onClick={openFilterFromChip}
                onRemove={() => onSearchChange({ where: undefined, page: undefined })}
              />
            )}
            {sort.map((s) => (
              <FilterChip
                key={`sort-${s.column}`}
                label={`${s.column} ${s.direction === 'asc' ? '↑' : '↓'}`}
                muted
                onRemove={() => onSearchChange({ sort: sort.filter((x) => x.column !== s.column) })}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={<Button aria-label="Refresh" onClick={refreshRows} size="icon-sm" variant="ghost" />}
              >
                <RefreshCwIcon className={cn(rowsQ.isFetching && 'animate-spin')} />
              </TooltipTrigger>
              <TooltipPopup>Refresh ({shortcut('R', { alt: true, shift: true, mod: false })})</TooltipPopup>
            </Tooltip>
            <ViewMenu
              columns={columns.map((c) => c.name)}
              hidden={hiddenSet}
              onHiddenChange={(names) => setHiddenColumns(viewKey, names)}
              onShowFractionChange={setShowFraction}
              onTimeZoneModeChange={setTimeZoneMode}
              showFraction={showFraction}
              timeZoneMode={timeZoneMode}
              zone={zone}
            />
            <ExportMenu
              disabled={!result}
              label="This page"
              onCopy={() => exportData('copy')}
              onCopyQuery={() => {
                if (!result) return
                void copyWithToast(result.sql, 'Query copied', result.sql)
              }}
              onExport={(format) => exportData(format)}
              wholeTable={{ label: hasFilters ? 'All matching rows' : 'Whole table', onExport: exportWholeTable }}
            />
            {(details?.kind === 'r' || details?.kind === 'p') && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    // a disabled button gets no pointer events: the wrapper shows why
                    <span className="inline-flex" />
                  }
                >
                  <Button
                    aria-label="Import CSV"
                    disabled={readOnly}
                    onClick={() => setImportOpen(true)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <UploadIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipPopup>{readOnly ? 'This connection is read-only' : 'Import CSV'}</TooltipPopup>
              </Tooltip>
            )}
            {editable && (
              <Tooltip>
                <TooltipTrigger render={<Button onClick={() => addRow()} size="sm" />}>
                  <PlusIcon aria-hidden="true" />
                  Add row
                </TooltipTrigger>
                <TooltipPopup>Add a row ({shortcut('N', { alt: true, shift: true, mod: false })})</TooltipPopup>
              </Tooltip>
            )}
          </div>
        </div>

        {/* grid, and the row panel next to it on wide screens */}
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {rowsQ.error ? (
              <div className="p-4">
                <Alert variant="error">
                  <CircleAlertIcon />
                  <AlertTitle>Could not load rows</AlertTitle>
                  <AlertDescription className="whitespace-pre-wrap break-words font-mono text-xs">
                    {rowsQ.error.message}
                  </AlertDescription>
                </Alert>
                {hasFilters && (
                  <Button
                    className="mt-3"
                    onClick={() =>
                      onSearchChange({ filters: undefined, where: undefined, q: undefined, page: undefined })
                    }
                    size="sm"
                    variant="outline"
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            ) : !result ? null : (
              <DataGrid
                columns={gridColumns}
                editable={editable}
                emptyState={
                  <Empty className="py-10">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <SearchXIcon />
                      </EmptyMedia>
                      <EmptyTitle className="text-base">
                        {hasFilters ? 'No matching rows' : 'This table is empty'}
                      </EmptyTitle>
                      <EmptyDescription>
                        {hasFilters ? (
                          <Button
                            className="h-auto p-0"
                            onClick={() =>
                              onSearchChange({ filters: undefined, where: undefined, q: undefined, page: undefined })
                            }
                            variant="link"
                          >
                            Clear filters
                          </Button>
                        ) : editable ? (
                          'Add the first row with the “Add row” button.'
                        ) : (
                          'There is nothing to show yet.'
                        )}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                }
                jumpTo={gridJumpTo}
                onActiveCellChange={(pos) => onActiveCellChange(pos && { ...pos, col: toOriginal(pos.col) })}
                onCellChange={editable ? (rowId, col, value) => onCellChange(rowId, toOriginal(col), value) : undefined}
                onCellsChange={
                  editable
                    ? (changes) => onCellsChange(changes.map((c) => ({ ...c, col: toOriginal(c.col) })))
                    : undefined
                }
                onDeleteRows={editable ? onDeleteRows : undefined}
                onDuplicateRow={editable ? onDuplicateRow : undefined}
                onFilter={onFilter}
                onFilterColumn={(name) => openFilter(name)}
                onHideColumn={(col) => {
                  const name = columns[toOriginal(col)]?.name
                  if (name) setHiddenColumns(viewKey, [...hiddenSet, name])
                }}
                onNavigateForeignKey={onNavigateForeignKey}
                onOpenRow={toggleRowPanel}
                onSelectedRowsChange={setSelected}
                openRowId={drawerRowId}
                onSortChange={(s) => onSearchChange({ sort: s.length ? s : undefined, page: undefined })}
                rowCountHint={rowCountHint}
                rowNumberOffset={start - pending.inserts.length}
                rows={gridRows}
                selectedRows={selected}
                sort={sort}
                storageKey={`${connectionId}:${database}:${schema}.${table}`}
              />
            )}
            {rowsQ.isFetching && result && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden">
                <div className="h-full w-1/3 animate-[loading_1s_ease-in-out_infinite] bg-primary/60" />
              </div>
            )}

            {/* Floating action bars. Each has its own fixed slot (pending changes at the bottom,
            selection above it) and a fixed width, so nothing moves when a bar appears or
            disappears, or when its counts change ("1 edited" → "1 edited · 1 deleted"). */}
            {selected.size > 0 && (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-16 z-30 flex justify-center px-3"
                data-floating-bar="selection"
              >
                <div className="pointer-events-auto flex w-full max-w-xs items-center gap-2 rounded-xl border bg-popover py-1.5 ps-3.5 pe-1.5 text-sm shadow-lg/10 transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0">
                  <span className="min-w-0 flex-1 truncate tabular-nums">{selected.size} selected</span>
                  <Button
                    onClick={() => {
                      const picked = rows.filter((r) => selected.has(r.id))
                      void copyWithToast(
                        toTsv(
                          columns,
                          picked.map((r) =>
                            r.values.map((v) => (typeof v === 'object' && v !== null ? null : (v ?? null))),
                          ),
                        ),
                        `Copied ${countLabel(picked.length, 'row')}`,
                      )
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    Copy
                  </Button>
                  {editable && (
                    <Button onClick={() => onDeleteRows([...selected])} size="sm" variant="destructive-outline">
                      <Trash2Icon aria-hidden="true" />
                      Delete
                    </Button>
                  )}
                  <Button
                    aria-label="Clear selection"
                    onClick={() => setSelected(new Set())}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </div>
              </div>
            )}
            {dirty && (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3"
                data-floating-bar="pending"
              >
                <div className="pointer-events-auto flex w-full max-w-[44rem] items-center gap-3 rounded-xl border bg-popover py-1.5 ps-3.5 pe-1.5 text-sm shadow-lg/10 transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0">
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {saveError || invalid.length ? (
                      <CircleAlertIcon aria-hidden="true" className="size-4 text-destructive-foreground" />
                    ) : (
                      <span className="relative flex size-2">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60" />
                        <span className="relative inline-flex size-2 rounded-full bg-warning" />
                      </span>
                    )}
                  </span>
                  {invalid.length || saveError?.rowId ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-live="polite"
                            className="h-auto min-w-0 flex-1 justify-start p-0 font-normal text-destructive-foreground tabular-nums"
                            onClick={() => {
                              const target =
                                invalid[0] ??
                                (saveError?.rowId ? { rowId: saveError.rowId, col: saveError.cols[0] ?? 0 } : null)
                              if (target) setJumpTo({ ...target, key: Date.now() })
                            }}
                            variant="link"
                          />
                        }
                      >
                        <span className="truncate">
                          {invalid.length
                            ? `${invalid.length > 1 ? `${invalid.length} to fix · ` : ''}${columns[invalid[0]!.col]?.name}: ${invalid[0]!.message}`
                            : `Not saved: ${saveError?.message}`}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup className="max-w-96 whitespace-pre-wrap">
                        {invalid.length
                          ? invalid.map((p) => `${columns[p.col]?.name}: ${p.message}`).join('\n')
                          : [saveError?.message, saveError?.detail].filter(Boolean).join('\n')}
                        {'\n'}Click to go to the cell.
                      </TooltipPopup>
                    </Tooltip>
                  ) : (
                    <span
                      aria-live="polite"
                      className={cn('min-w-0 flex-1 truncate tabular-nums', saveError && 'text-destructive-foreground')}
                      title={
                        saveError ? [saveError.message, saveError.detail].filter(Boolean).join('\n') : pendingSummary
                      }
                    >
                      {saveError ? `Not saved: ${saveError.message}` : pendingSummary}
                    </span>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label="Undo"
                            disabled={!history.canUndo}
                            onClick={history.undo}
                            size="icon-sm"
                            variant="ghost"
                          />
                        }
                      >
                        <Undo2Icon />
                      </TooltipTrigger>
                      <TooltipPopup>Undo ({shortcut('Z')})</TooltipPopup>
                    </Tooltip>
                    <Button
                      onClick={() => {
                        setPreviewText(previewSql(buildChanges(schema, table, pending, fieldNames, keyFor)))
                        setPreviewError(saveError)
                        setPreviewOpen(true)
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <FileCodeIcon aria-hidden="true" />
                      <span className="max-sm:hidden">Review SQL</span>
                    </Button>
                    <Button onClick={discard} size="sm" variant="ghost">
                      Discard
                    </Button>
                    <Button loading={saveMutation.isPending} onClick={saveSoon} size="sm">
                      Save changes
                      <Kbd className="-me-1 bg-primary-foreground/15 text-primary-foreground/80">{shortcut('S')}</Kbd>
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {docked && rowPanel}
        </div>

        {/* footer / pagination */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5 text-muted-foreground text-xs">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <Select
              items={PAGE_SIZES.map((n) => ({ label: String(n), value: n }))}
              onValueChange={(v) => {
                setDefaultPageSize(v as number)
                onSearchChange({ size: v as number, page: undefined })
              }}
              value={pageSize}
            >
              <SelectTrigger aria-label="Rows per page" className="w-20 min-w-0" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {result && (
              <span className="inline-block min-w-[8ch] tabular-nums max-sm:hidden">
                · {formatDuration(result.durationMs)}
              </span>
            )}
            {!editable && details && !readOnly && (
              <Badge variant="outline">
                read-only {details.kind === 'v' ? 'view' : details.kind === 'm' ? 'materialized view' : 'relation'}
              </Badge>
            )}
            {readOnly && <Badge variant="warning">read-only connection</Badge>}
          </div>
          <div className="flex items-center gap-1">
            <span
              className="me-2 text-right tabular-nums"
              style={{ minWidth: `${`${widestCount}–${widestCount} of ~${widestCount}`.length}ch` }}
            >
              {shown === 0
                ? total === 0
                  ? 'No rows'
                  : `Page ${page}`
                : `${formatCount(start + 1)}–${formatCount(start + shown)}`}
              {total != null && shown > 0 && (
                <>
                  {' '}
                  of {countQ.data?.exact ? '' : '~'}
                  {formatCount(total)}
                </>
              )}
              {total == null && countQ.isFetching && ' of …'}
            </span>
            <Button
              aria-label="First page"
              disabled={page <= 1}
              onClick={() => onSearchChange({ page: undefined })}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronsLeftIcon />
            </Button>
            <Button
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => onSearchChange({ page: page - 1 > 1 ? page - 1 : undefined })}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <span
              className="px-1 text-center tabular-nums"
              style={{ minWidth: `${Math.max(7, String(totalPages ?? page).length * 2 + 3)}ch` }}
            >
              {page}
              {totalPages ? ` / ${formatCount(totalPages)}` : ''}
            </span>
            <Button
              aria-label="Next page"
              disabled={!hasNext}
              onClick={() => onSearchChange({ page: page + 1 })}
              size="icon-xs"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>

        {!docked && rowPanel}

        {details && (
          <ImportCsvDialog
            columns={details.columns}
            connectionId={connectionId}
            database={database}
            onOpenChange={setImportOpen}
            open={importOpen}
            schema={schema}
            table={table}
          />
        )}
        <Dialog onOpenChange={setPreviewOpen} open={previewOpen}>
          <DialogPopup className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Review changes</DialogTitle>
              <DialogDescription>
                These statements run in a single transaction. If one fails, nothing is saved.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              {previewError && (
                <Alert variant="error">
                  <CircleAlertIcon />
                  <AlertTitle>The last save failed. Nothing was saved.</AlertTitle>
                  <AlertDescription className="break-words">
                    <span>{previewError.message}</span>
                    {previewError.detail && <span className="whitespace-pre-wrap">{previewError.detail}</span>}
                  </AlertDescription>
                </Alert>
              )}
              <div className="overflow-hidden rounded-lg border bg-muted/30">
                <SqlCodeView maxHeight="55vh" value={previewText} />
              </div>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
              <Button
                loading={saveMutation.isPending}
                onClick={() => {
                  setPreviewOpen(false)
                  save()
                }}
              >
                Save changes
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </div>
    </LookupContext.Provider>
  )
}

function FilterChip({
  label,
  onRemove,
  onClick,
  muted,
}: {
  label: string
  onRemove: () => void
  onClick?: () => void
  muted?: boolean
}) {
  return (
    <Group className="max-w-64">
      <Button
        className={cn('min-w-0 font-mono text-xs', muted && 'border-dashed text-muted-foreground')}
        onClick={onClick}
        size="xs"
        variant={muted ? 'outline' : 'secondary'}
      >
        <span className="truncate">{label}</span>
      </Button>
      <Button
        aria-label={`Remove ${label}`}
        className={cn(muted && 'border-dashed text-muted-foreground')}
        onClick={onRemove}
        size="icon-xs"
        variant={muted ? 'outline' : 'secondary'}
      >
        <XIcon />
      </Button>
    </Group>
  )
}

function ViewMenu({
  columns,
  hidden,
  onHiddenChange,
  timeZoneMode,
  onTimeZoneModeChange,
  showFraction,
  onShowFractionChange,
  zone,
}: {
  columns: string[]
  hidden: ReadonlySet<string>
  onHiddenChange: (names: string[]) => void
  timeZoneMode: 'local' | 'utc'
  onTimeZoneModeChange: (mode: 'local' | 'utc') => void
  showFraction: boolean
  onShowFractionChange: (v: boolean) => void
  zone: string
}) {
  const hiddenCount = columns.filter((c) => hidden.has(c)).length
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="View options"
                  className={cn(hiddenCount > 0 && 'text-foreground')}
                  size={hiddenCount ? 'sm' : 'icon-sm'}
                  variant={hiddenCount ? 'secondary' : 'ghost'}
                />
              }
            />
          }
        >
          <Columns3Icon />
          {hiddenCount > 0 && <span className="tabular-nums">{hiddenCount} hidden</span>}
        </TooltipTrigger>
        <TooltipPopup>Columns and time format</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="max-h-[min(32rem,var(--available-height))] min-w-60">
        <MenuGroup>
          <MenuGroupLabel>Show times in</MenuGroupLabel>
          <MenuRadioGroup onValueChange={(v) => onTimeZoneModeChange(v as 'local' | 'utc')} value={timeZoneMode}>
            <MenuRadioItem value="local">Your time ({zone})</MenuRadioItem>
            <MenuRadioItem value="utc">As stored (server time)</MenuRadioItem>
          </MenuRadioGroup>
          <MenuCheckboxItem checked={showFraction} onCheckedChange={onShowFractionChange}>
            Show microseconds
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Columns</MenuGroupLabel>
          {columns.map((name) => (
            <MenuCheckboxItem
              checked={!hidden.has(name)}
              closeOnClick={false}
              // at least one column stays visible
              disabled={!hidden.has(name) && hiddenCount === columns.length - 1}
              key={name}
              onCheckedChange={(checked) =>
                onHiddenChange(checked ? [...hidden].filter((n) => n !== name) : [...hidden, name])
              }
            >
              <span className="truncate font-mono text-xs">{name}</span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        {hiddenCount > 0 && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onHiddenChange([])}>Show all columns</MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  )
}

/** Whether a staged value is just the stored one again (incl. a timestamptz written in another zone). */
function isOriginal(value: GridValue, original: Cell | undefined, column: GridColumn | undefined): boolean {
  if (value === original || (typeof value === 'object' && value !== null)) return true
  return (
    column?.kind === 'timestamp' &&
    typeof value === 'string' &&
    typeof original === 'string' &&
    isZoned(column.typeName) &&
    sameTimestamptz(value, original)
  )
}
