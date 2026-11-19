import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  KeyRoundIcon,
  LinkIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { isDefaultMarker } from '@/components/grid/types'
import {
  ArrayField,
  BooleanField,
  FieldProblem,
  ForeignKeyField,
  TemporalField,
  columnSpec,
  isTemporal,
  localTimeHint,
  textToValue,
} from '@/components/grid/value-editors'
import type { GridColumn, GridRow, GridValue } from '@/components/grid/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { shortcut } from '@/hooks/use-hotkey'
import { rowToObject } from '@/lib/export'
import { copyWithAnchoredToast } from '@/components/app/copy-feedback'
import { CopyButton } from '@/components/app/copy-button'
import { cellToText } from '@/lib/format'
import { isZoned, toLocalTimestamptz } from '@/lib/time'
import { validateValue } from '@/lib/validate'
import type { Cell } from '@/lib/types'
import { cn } from '@/lib/utils'

const NULL = '\u0000null'

interface PanelSave {
  /** "2 edited · 1 new", or "" when nothing is staged */
  summary: string
  /** first thing that blocks saving, if any */
  problem: string | null
  saving: boolean
  onSave: () => void
}

export function RowDrawer({
  row,
  original,
  columns,
  title,
  editable,
  position,
  docked,
  save,
  onClose,
  onChange,
  onToggleDelete,
  onPrev,
  onNext,
  onNavigateForeignKey,
}: {
  row: GridRow | null
  /** values as stored in the database (existing rows), so edited fields can be reverted */
  original?: readonly GridValue[]
  columns: GridColumn[]
  title: string
  editable: boolean
  position?: string
  /** a side panel next to the grid (wide screens) instead of a drawer over it */
  docked: boolean
  /** the table's staged changes, saved from here without going back to the grid */
  save?: PanelSave
  onClose: () => void
  onChange: (col: number, value: GridValue) => void
  /** discard a new row, mark an existing one for deletion, or restore it */
  onToggleDelete?: () => void
  onPrev?: () => void
  onNext?: () => void
  onNavigateForeignKey?: (fk: NonNullable<GridColumn['foreignKey']>, value: string) => void
}) {
  // Freeze the content while open; the parent sets `row` to null to close the
  // drawer, but it keeps sliding out for a moment and must not empty itself.
  const current = {
    row,
    original,
    columns,
    title,
    position,
    editable,
    canToggleDelete: Boolean(onToggleDelete),
    hasPrev: Boolean(onPrev),
    hasNext: Boolean(onNext),
  }
  // Kept while the panel slides shut. A changed row updates it during render, not in an effect.
  const [kept, setKept] = useState(current)
  const changed = Boolean(row) && (Object.keys(current) as (keyof typeof current)[]).some((k) => current[k] !== kept[k])
  if (changed) setKept(current)
  const shown = changed ? current : kept
  // A closed panel keeps its last row only while it slides out (docked: 200ms; drawer: its exit
  // animation), then renders nothing, so nothing is built for a panel that is shut.
  const [hidden, setHidden] = useState(true)
  if (row && hidden) setHidden(false)
  useEffect(() => {
    if (row) return
    const t = setTimeout(() => setHidden(true), docked ? 220 : 500)
    return () => clearTimeout(t)
  }, [row, docked])
  const shownRow = shown.row
  const status = shownRow?.status
  const canEdit = shown.editable && status !== 'deleted'
  const bodyRef = useRef<HTMLDivElement>(null)
  const description =
    status === 'new'
      ? 'Not saved yet. Fill in the values, then save.'
      : [shown.position, canEdit ? null : status === 'deleted' ? null : 'read-only'].filter(Boolean).join(' · ')

  // a new row: straight into its first required field (or the first one that can be typed in)
  const rowId = shownRow?.id
  // runs when the shown row changes; reads the current status and layout
  const focusNewRowField = useEffectEvent(() => {
    if (status !== 'new') return
    const t = setTimeout(
      () => {
        const body = bodyRef.current
        const field = 'input:not([readonly]):not([type=hidden]), textarea:not([readonly])'
        // required first; otherwise the first field that is not filled in automatically (ids, keys)
        const target =
          body?.querySelector<HTMLElement>(`[data-required] :is(${field})`) ??
          body?.querySelector<HTMLElement>(`[data-field]:not([data-auto]) :is(${field})`) ??
          body?.querySelector<HTMLElement>(field)
        target?.focus()
      },
      docked ? 0 : 250,
    )
    return () => clearTimeout(t)
  })
  useEffect(() => focusNewRowField(), [rowId])

  const fields =
    !hidden &&
    shownRow &&
    shown.columns.map((column, i) => {
      // a new row is new as a whole: only changes to stored rows are marked per field
      const edited = status === undefined && (shownRow.edited?.has(i) ?? false)
      return (
        <FieldRow
          column={column}
          edited={edited}
          editable={canEdit && !(column.readOnly && status !== 'new')}
          isNew={status === 'new'}
          key={`${shownRow.id}-${i}`}
          onChange={(v) => row && onChange(i, v)}
          onNavigateForeignKey={onNavigateForeignKey}
          onRevert={
            edited && canEdit && shown.original ? () => row && onChange(i, shown.original![i] ?? null) : undefined
          }
          problem={shownRow.issues?.get(i) ?? null}
          value={shownRow.values[i]}
        />
      )
    })

  const rowActions = (
    <div className="flex items-center justify-between gap-2">
      <div className="flex gap-1">
        {shown.canToggleDelete && shown.editable && (
          <Button
            className={cn(status !== 'deleted' && 'text-destructive-foreground')}
            onClick={() => row && onToggleDelete?.()}
            size="sm"
            variant={status === 'deleted' ? 'outline' : 'ghost'}
          >
            {status === 'deleted' ? <Undo2Icon aria-hidden="true" /> : <Trash2Icon aria-hidden="true" />}
            {status === 'new' ? 'Discard row' : status === 'deleted' ? 'Restore row' : 'Delete row'}
          </Button>
        )}
        <CopyButton
          label="Copy JSON"
          size="sm"
          text={
            shownRow
              ? JSON.stringify(
                  rowToObject(
                    shown.columns,
                    shownRow.values.map((v) => (v === undefined || isDefaultMarker(v) ? null : v)) as Cell[],
                  ),
                  null,
                  2,
                )
              : ''
          }
          variant="ghost"
        >
          Copy JSON
        </CopyButton>
      </div>
      <div className="flex gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Previous row"
                disabled={!shown.hasPrev}
                onClick={onPrev}
                size="icon-sm"
                variant="outline"
              />
            }
          >
            <ChevronUpIcon />
          </TooltipTrigger>
          <TooltipPopup>Previous row</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Next row"
                disabled={!shown.hasNext}
                onClick={onNext}
                size="icon-sm"
                variant="outline"
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipPopup>Next row</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  )

  // always there (disabled when nothing is staged), so the footer never changes height
  const saveBar = save && shown.editable && (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-xs tabular-nums',
          save.problem ? 'text-destructive-foreground' : save.summary ? 'text-foreground' : 'text-muted-foreground',
        )}
        title={save.problem ?? save.summary}
      >
        {save.problem ?? (save.summary || 'No unsaved changes')}
      </span>
      <Button disabled={!save.summary} loading={save.saving} onClick={save.onSave} size="sm">
        Save
        <Kbd className="-me-1 bg-primary-foreground/15 text-primary-foreground/80">{shortcut('S')}</Kbd>
      </Button>
    </div>
  )

  const heading = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{shown.title}</span>
      {status === 'deleted' && <Badge variant="error">Marked for deletion</Badge>}
    </span>
  )

  if (docked) {
    const visible = Boolean(row)
    // the panel slides in by growing from the right edge; the grid narrows along with it
    return (
      <div
        className={cn(
          'flex shrink-0 justify-start overflow-hidden border-l bg-background transition-[width,border-color] duration-200 ease-out motion-reduce:transition-none',
          visible ? 'w-[min(26rem,40vw)]' : 'w-0 border-l-0',
        )}
        inert={!visible}
      >
        {!hidden && shownRow && (
          <aside aria-label="Row details" className="flex h-full w-[min(26rem,40vw)] shrink-0 flex-col">
            <div className="flex items-start gap-2 border-b px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-heading font-semibold text-base leading-tight">{heading}</h2>
                <p className="mt-0.5 truncate text-muted-foreground text-xs">{description || '\u00a0'}</p>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={<Button aria-label="Close row details" onClick={onClose} size="icon-sm" variant="ghost" />}
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup>Close (or press Space in the table)</TooltipPopup>
              </Tooltip>
            </div>
            <div
              className={cn(
                'scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 transition-opacity',
                status === 'deleted' && 'opacity-56',
              )}
              ref={bodyRef}
            >
              {fields}
            </div>
            <div className="flex flex-col gap-2 border-t px-3 py-2">
              {saveBar}
              {rowActions}
            </div>
          </aside>
        )}
      </div>
    )
  }

  return (
    <Drawer onOpenChange={(open) => !open && onClose()} open={Boolean(row)} position="right">
      <DrawerPopup className="sm:max-w-lg" showCloseButton>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">{heading}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        {/* a row marked for deletion is dimmed, like its struck-through line in the grid */}
        <DrawerPanel className={cn('flex flex-col gap-4 transition-opacity', status === 'deleted' && 'opacity-56')}>
          <div className="flex flex-col gap-4" ref={bodyRef}>
            {fields}
          </div>
        </DrawerPanel>
        <DrawerFooter className="flex-col gap-2 sm:flex-col">
          {saveBar}
          {rowActions}
        </DrawerFooter>
      </DrawerPopup>
    </Drawer>
  )
}

function FieldRow({
  column,
  value,
  editable,
  edited,
  isNew,
  onChange,
  onRevert,
  onNavigateForeignKey,
  problem,
}: {
  column: GridColumn
  value: GridValue | undefined
  editable: boolean
  edited: boolean
  isNew: boolean
  onChange: (value: GridValue) => void
  onRevert?: () => void
  /** what is wrong with the staged value (validation or the last save), if anything */
  problem: string | null
  onNavigateForeignKey?: (fk: NonNullable<GridColumn['foreignKey']>, value: string) => void
}) {
  const isNull = value === null
  const isDefault = value === undefined || isDefaultMarker(value)
  const text = typeof value === 'string' ? value : typeof value === 'boolean' ? String(value) : ''
  const fk = column.foreignKey && typeof value === 'string' && !isNew ? column.foreignKey : null
  const ref = column.foreignKey && typeof value === 'string' ? column.refLabels?.get(value) : undefined
  const required = isNew && column.nullable === false && !column.hasDefault && !column.readOnly
  const auto = column.readOnly || (column.isPrimaryKey && column.hasDefault)

  return (
    // a changed field gets a bar in the left gutter (inside the panel padding, so never clipped)
    <div
      data-auto={auto || undefined}
      data-field=""
      data-required={required || undefined}
      className={cn(
        'relative flex flex-col gap-1.5',
        edited && 'before:absolute before:inset-y-0 before:-start-3 before:w-0.5 before:rounded-full before:bg-warning',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {column.isPrimaryKey && <KeyRoundIcon aria-label="Primary key" className="size-3 shrink-0 text-amber-500" />}
        {!column.isPrimaryKey && column.foreignKey && (
          <LinkIcon aria-label="Foreign key" className="size-3 shrink-0 text-blue-500" />
        )}
        <span className="truncate font-medium font-mono text-[13px]">{column.name}</span>
        <span className="truncate font-mono text-muted-foreground text-xs">{column.typeName}</span>
        {column.nullable === false && <span className="text-[10px] text-muted-foreground uppercase">not null</span>}
        {edited && <span className="font-medium text-[10px] text-warning-foreground uppercase">edited</span>}
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {onRevert && (
            <Tooltip>
              <TooltipTrigger render={<Button onClick={onRevert} size="xs" variant="ghost" />}>
                <Undo2Icon aria-hidden="true" />
                Revert
              </TooltipTrigger>
              <TooltipPopup>Go back to the saved value</TooltipPopup>
            </Tooltip>
          )}
          {fk && onNavigateForeignKey && (
            <Tooltip>
              <TooltipTrigger
                render={<Button onClick={() => onNavigateForeignKey(fk, value as string)} size="xs" variant="ghost" />}
              >
                {fk.table}
                <ArrowUpRightIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup>
                Open the {fk.table} row with {fk.column} = {value as string}
              </TooltipPopup>
            </Tooltip>
          )}
          {/* not offered when the field already ends up NULL (a default without a default value) */}
          {editable && column.nullable && !isNull && !(isDefault && !column.hasDefault) && (
            <Button onClick={() => onChange(null)} size="xs" variant="ghost">
              Set NULL
            </Button>
          )}
          {editable && isNew && column.hasDefault && !isDefault && (
            <Button onClick={() => onChange({ default: true })} size="xs" variant="ghost">
              Use default
            </Button>
          )}
          <Button
            aria-label="Copy value"
            disabled={isNull || isDefault}
            onClick={(e) => {
              void copyWithAnchoredToast(
                isNull || isDefault ? '' : cellToText(value as Cell),
                e.currentTarget,
                'Copied',
              )
            }}
            size="icon-xs"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
        </span>
      </div>
      <ValueEditor
        column={column}
        editable={editable}
        isDefault={isDefault}
        isNew={isNew}
        isNull={isNull}
        onChange={onChange}
        problem={problem}
        text={text}
      />
      {ref?.label != null && (
        <p className="truncate text-muted-foreground text-xs">
          {column.foreignKey!.table}: <span className="text-foreground">{ref.label}</span>
          {ref.detail ? ` · ${ref.detail}` : ''}
        </p>
      )}
      {column.comment && <p className="text-muted-foreground text-xs">{column.comment}</p>}
    </div>
  )
}

function ValueEditor({
  column,
  text,
  isNull,
  isDefault,
  isNew,
  editable,
  onChange,
  problem,
}: {
  column: GridColumn
  text: string
  isNull: boolean
  isDefault: boolean
  isNew: boolean
  editable: boolean
  onChange: (value: GridValue) => void
  problem: string | null
}) {
  // a timestamptz shown in local time in the grid is shown (and edited) in local time here too
  const localTime = column.kind === 'timestamp' && column.timeDisplay?.timeZone === 'local' && isZoned(column.typeName)
  const pretty =
    column.kind === 'json' ? prettyJson(text) : localTime && text ? (toLocalTimestamptz(text) ?? text) : text
  const [local, setLocal] = useState(pretty)
  const [prevPretty, setPrevPretty] = useState(pretty)
  if (pretty !== prevPretty) {
    setPrevPretty(pretty)
    setLocal(pretty)
  }
  // what an empty field will become when the row is saved
  const placeholder = isNull
    ? 'NULL'
    : isDefault
      ? column.defaultValue
        ? describeDefault(column.defaultValue)
        : column.nullable
          ? 'NULL'
          : 'Required'
      : ''
  // while typing: the same check the grid and the save use, on what is in the field now
  const dirty = local !== pretty
  // (a foreign-key field doubles as a search box: it is only judged once a value is chosen)
  const live =
    dirty && !column.foreignKey ? validateValue(textToValue(local, column, isNew), columnSpec(column), { isNew }) : null
  const shownProblem = editable ? (dirty && !column.foreignKey ? live : problem) : null
  const errorId = useId()
  const invalid = Boolean(shownProblem)

  const commit = (next = local) => {
    if (next === pretty) return
    if (next === '' && (isNull || isDefault)) return
    if (column.kind === 'json' && sameJson(next, text)) return
    onChange(textToValue(next, column, isNew))
  }

  let field: React.ReactNode
  if (column.kind === 'boolean') {
    field = (
      <BooleanField
        disabled={!editable}
        invalid={invalid}
        // NULL is set from the field header ("Set NULL"), like every other column here
        nullable={false}
        onChange={onChange}
        defaultChoice={column.defaultValue === 'true' ? true : column.defaultValue === 'false' ? false : undefined}
        placeholder={isDefault ? placeholder : undefined}
        value={isNull ? null : isDefault ? undefined : text === 'true' || text === 't'}
      />
    )
  } else if (column.kind === 'enum' && column.enumValues?.length) {
    const options = column.enumValues.map((v) => ({ label: v, value: v }))
    if (column.nullable) options.push({ label: 'NULL', value: NULL })
    const current = isNull ? NULL : isDefault ? null : text
    field = (
      <Select
        disabled={!editable}
        items={options}
        onValueChange={(v) => onChange(v === NULL ? null : (v as string))}
        value={current}
      >
        <SelectTrigger aria-invalid={invalid || undefined} className="font-mono text-[13px]" size="sm">
          <SelectValue placeholder={placeholder || 'NULL'} />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((o) => (
            <SelectItem className="font-mono text-[13px]" key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    )
  } else if (column.kind === 'array' && editable) {
    field = (
      <ArrayField
        onCommit={(literal) =>
          onChange(literal === null ? (isNew && column.hasDefault ? { default: true } : null) : literal)
        }
        placeholder={placeholder || undefined}
        typeName={column.typeName}
        value={isNull || isDefault ? null : text}
      />
    )
  } else if (isTemporal(column.kind) && editable) {
    field = (
      <TemporalField
        invalid={invalid}
        kind={column.kind}
        onChange={setLocal}
        onCommit={commit}
        placeholder={placeholder || undefined}
        typeName={column.typeName}
        value={local}
      />
    )
  } else if (column.foreignKey && editable) {
    field = (
      <ForeignKeyField
        fk={column.foreignKey}
        invalid={invalid}
        onChange={setLocal}
        onCommit={commit}
        placeholder={placeholder || `Search ${column.foreignKey.table}…`}
        value={local}
      />
    )
  } else {
    const multiline = column.kind === 'json' || local.length > 60 || local.includes('\n')
    // read-only values look like plain text boxes, not like fields waiting for input
    const readOnlyLook = !editable && 'border-transparent bg-muted/50 shadow-none before:hidden dark:bg-muted/50'
    field = multiline ? (
      <Textarea
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid || undefined}
        className={cn('font-mono text-[13px] *:data-[slot=textarea]:max-h-72', readOnlyLook)}
        onBlur={() => commit()}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        readOnly={!editable}
        rows={Math.min(10, Math.max(2, local.split('\n').length))}
        spellCheck={false}
        value={local}
      />
    ) : (
      <Input
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid || undefined}
        className={cn('font-mono text-[13px]', readOnlyLook)}
        onBlur={() => commit()}
        onChange={(e) => setLocal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        placeholder={placeholder}
        readOnly={!editable}
        size="sm"
        spellCheck={false}
        value={local}
      />
    )
  }

  const hint = !shownProblem && local && !localTime ? localTimeHint(local, column.kind, column.typeName) : null
  return (
    <>
      {field}
      <FieldProblem id={errorId}>{shownProblem}</FieldProblem>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </>
  )
}

/** A column default as a person reads it: "Auto-generated", "Default: pending", "Default: now()" */
function describeDefault(expr: string): string {
  if (expr === 'identity' || expr.startsWith('nextval(')) return 'Auto-generated'
  const literal = /^'((?:[^']|'')*)'::[\w\s."[\]]+$/.exec(expr)
  return `Default: ${literal ? literal[1]!.replace(/''/g, "'") : expr}`
}

function prettyJson(text: string): string {
  if (!text) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function sameJson(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))
  } catch {
    return false
  }
}
