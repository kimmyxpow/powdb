/**
 * Typed value editors shared by the row panel, the value editor dialog, the grid
 * and the filter popover: a date/time field with a calendar, an array list editor
 * and a foreign-key picker. All of them stage plain PostgreSQL text.
 */
import type { DropdownProps } from '@daypicker/react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  ClockIcon,
  CircleSlashIcon,
  PlusIcon,
  TextCursorInputIcon,
  XIcon,
} from 'lucide-react'
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from '@/components/ui/autocomplete'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { parsePgArray, toPgArray } from '@/lib/pg-array'
import { referenceQuery } from '@/lib/queries'
import type { ReferenceOption, ValueKind } from '@/lib/types'
import { checkText, elementTypeName, kindFromTypeName } from '@/lib/validate'
import type { ValueSpec } from '@/lib/validate'
import { cn } from '@/lib/utils'
import type { GridColumn, GridValue } from './types'

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Where foreign keys are looked up (provided by the table view). */
export const LookupContext = createContext<{ connectionId: string; database: string } | null>(null)

export function columnSpec(c: GridColumn): ValueSpec {
  return {
    kind: c.kind,
    typeName: c.typeName,
    fullType: c.fullType,
    nullable: c.nullable,
    hasDefault: c.hasDefault,
    readOnly: c.readOnly,
    enumValues: c.enumValues,
  }
}

const TEXTUAL: ReadonlySet<ValueKind> = new Set(['text', 'other', 'binary'])

/**
 * Text typed into an editor → the staged value. Clearing a field of a new row
 * goes back to its default; clearing a non-text field means NULL.
 */
export function textToValue(text: string, column: GridColumn, isNew = false): GridValue {
  if (text !== '') return text
  if (isNew && (column.hasDefault || column.readOnly)) return { default: true }
  return TEXTUAL.has(column.kind) ? '' : null
}

export const isTemporal = (kind: ValueKind) => kind === 'date' || kind === 'timestamp' || kind === 'time'

// ---------------------------------------------------------------------------
// date / time
// ---------------------------------------------------------------------------

interface Temporal {
  date: string
  time: string
  frac: string
  offset: string
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

function parseTemporal(text: string): Temporal | null {
  const m = /^(\d{4,}-\d{2}-\d{2})?(?:[ T]?(\d{2}:\d{2}(?::\d{2})?)(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
    text.trim(),
  )
  if (!m || (!m[1] && !m[2])) return null
  const time = m[2] ? (m[2].length === 5 ? `${m[2]}:00` : m[2]) : ''
  return { date: m[1] ?? '', time, frac: m[3] ?? '', offset: m[4] ?? '' }
}

function localOffset(d = new Date()): string {
  const minutes = -d.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const h = pad(Math.floor(Math.abs(minutes) / 60))
  const m = Math.abs(minutes) % 60
  return `${sign}${h}${m ? `:${pad(m)}` : ''}`
}

const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const withZone = (typeName: string) => typeName === 'timestamptz' || typeName === 'timetz'

function formatTemporal(kind: ValueKind, typeName: string, t: Temporal): string {
  if (kind === 'date') return t.date
  const offset = withZone(typeName) ? t.offset || localOffset() : ''
  const time = `${t.time || '00:00:00'}${t.frac}${offset}`
  return kind === 'time' ? time : `${t.date || localDate(new Date())} ${time}`
}

/** "Now" in the shape of the column type (time zones: your own offset). */
function nowText(kind: ValueKind, typeName: string): string {
  const d = new Date()
  return formatTemporal(kind, typeName, { date: localDate(d), time: localTime(d), frac: '', offset: localOffset(d) })
}

/** For values with a time zone: the same moment in the browser's time zone, when that differs. */
export function localTimeHint(text: string, kind: ValueKind, typeName: string): string | null {
  if (kind !== 'timestamp' || !withZone(typeName)) return null
  const t = parseTemporal(text)
  if (!t?.date || !t.time || !t.offset) return null
  const offset =
    t.offset.toUpperCase() === 'Z'
      ? '+00:00'
      : t.offset.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2').replace(/^([+-]\d{2})$/, '$1:00')
  const d = new Date(`${t.date}T${t.time}${t.frac.slice(0, 4)}${offset}`)
  if (Number.isNaN(d.getTime())) return null
  if (offset === localOffset(d).replace(/^([+-]\d{2})$/, '$1:00')) return null
  // (dateStyle/timeStyle cannot be combined with timeZoneName, so the zone is added separately)
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(d)
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value
  return `Your time: ${when}${zone ? ` ${zone}` : ''}`
}

/** Month / year navigation with the coss Select. */
function CalendarDropdown({ options, value, onChange, 'aria-label': ariaLabel }: DropdownProps) {
  const items = (options ?? []).map((o) => ({ disabled: o.disabled, label: o.label, value: String(o.value) }))
  return (
    <Select
      aria-label={ariaLabel}
      items={items}
      onValueChange={(v) => {
        if (v && onChange) onChange({ target: { value: v } } as React.ChangeEvent<HTMLSelectElement>)
      }}
      value={value?.toString()}
    >
      <SelectTrigger className="min-w-0" size="sm">
        <SelectValue />
      </SelectTrigger>
      {/* (as in the coss example: the chosen month / year opens right over the trigger) */}
      <SelectPopup>
        {items.map((item) => (
          <SelectItem disabled={item.disabled} key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}

// ---- 24-hour time input (after the coss "Calendar with 24-hour autocomplete time input" example) ----

const QUARTER_HOURS = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`)

/** "2028" / "20:28" / "202834" / "20:28:34" / "9" → "HH:MM:SS", or null. */
function parseClock(value: string): string | null {
  const t = value.trim()
  if (!t) return null
  let h: number
  let m: number
  let s: number
  const colon = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(t)
  if (colon) {
    h = Number(colon[1])
    m = Number(colon[2])
    s = Number(colon[3] ?? 0)
  } else {
    const d = t.replace(/\D/g, '')
    if (!d || d.length > 6 || d.length !== t.length) return null
    if (d.length <= 2) [h, m, s] = [Number(d), 0, 0]
    else if (d.length === 3) [h, m, s] = [Number(d[0]), Number(d.slice(1)), 0]
    else if (d.length === 4) [h, m, s] = [Number(d.slice(0, 2)), Number(d.slice(2)), 0]
    else if (d.length === 5) [h, m, s] = [Number(d[0]), Number(d.slice(1, 3)), Number(d.slice(3))]
    else [h, m, s] = [Number(d.slice(0, 2)), Number(d.slice(2, 4)), Number(d.slice(4))]
  }
  if (h > 23 || m > 59 || s > 59) return null
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** Suggestions that start with what was typed, by digits ("61" → 06:15, "2" → 02:…, 20:…–23:…). */
function matchesClock(item: string, query: string): boolean {
  const q = query.trim()
  if (!q) return true
  const digits = q.replace(/\D/g, '')
  if (!digits) return false
  const itemDigits = item.replace(/\D/g, '')
  const unpadded = `${Number(itemDigits.slice(0, 2))}${itemDigits.slice(2)}`
  return itemDigits.startsWith(digits.slice(0, 4)) || unpadded.startsWith(digits.slice(0, 4))
}

/**
 * Type a time (24-hour, seconds optional, "2028" works) or pick a quarter hour.
 * `value` / `onChange` use HH:MM:SS.
 */
function ClockField({ value, onChange }: { value: string; onChange: (time: string) => void }) {
  const [text, setText] = useState(value)
  const [editing, setEditing] = useState(false)
  // outside typing the field shows the value itself, so `text` only matters while editing
  const shown = editing ? text : value
  const query = editing ? text : ''
  const matching = QUARTER_HOURS.filter((t) => matchesClock(t, query))
  return (
    <Autocomplete
      autoHighlight
      filter={(item: string, q) => matchesClock(item, editing ? q : '')}
      items={QUARTER_HOURS}
      onValueChange={(v, details) => {
        setText(v)
        setEditing(details.reason !== 'item-press')
        if (details.reason === 'item-press' || /^\d{2}:\d{2}(:\d{2})?$/.test(v)) {
          const parsed = parseClock(v)
          if (parsed) onChange(parsed)
        }
      }}
      openOnInputClick
      value={shown}
    >
      <AutocompleteInput
        aria-label="Time (24-hour)"
        className="font-mono"
        inputMode="numeric"
        maxLength={8}
        onBlur={() => {
          const parsed = parseClock(shown)
          if (parsed) {
            setText(parsed)
            if (parsed !== value) onChange(parsed)
          } else setText(value)
          setEditing(false)
        }}
        onFocus={(e) => {
          setEditing(false)
          e.currentTarget.select()
        }}
        placeholder="HH:MM:SS"
        size="sm"
        startAddon={<ClockIcon aria-hidden="true" />}
      />
      <AutocompletePopup className={matching.length === 0 ? 'hidden' : undefined}>
        <AutocompleteList>
          {(item: string) => (
            <AutocompleteItem className="font-mono" key={item} value={item}>
              {item}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  )
}

/**
 * Calendar + time + shortcuts, all as wide as the calendar so the panel stays a
 * tidy block. Times are 24-hour; the fraction of a second and the offset of the
 * value are kept until you change the time.
 */
export function TemporalPicker({
  kind,
  typeName,
  value,
  onPick,
  onDone,
  fill = false,
}: {
  kind: ValueKind
  typeName: string
  value: string
  onPick: (text: string) => void
  /** closes the popover (not shown when the picker sits inline) */
  onDone?: () => void
  /** stretch to the width of the container (cells grow), instead of the calendar's own width */
  fill?: boolean
}) {
  const parsed = parseTemporal(value)
  const t: Temporal = parsed ?? { date: '', time: '', frac: '', offset: '' }
  const selected = t.date ? new Date(`${t.date}T00:00:00`) : undefined
  // read once per mount: the picker's year range does not need to follow the clock while it is open
  const [thisYear] = useState(() => new Date().getFullYear())
  const zone = withZone(typeName) ? t.offset || localOffset() : null
  // the shown month follows what is typed in the field (and the picks)
  const [month, setMonth] = useState<Date>(() => selected ?? new Date())
  const selectedKey = t.date
  const [prevSelectedKey, setPrevSelectedKey] = useState(selectedKey)
  if (selectedKey !== prevSelectedKey) {
    setPrevSelectedKey(selectedKey)
    if (selectedKey) {
      const date = new Date(`${selectedKey}T00:00:00`)
      if (!Number.isNaN(date.getTime())) setMonth(date)
    }
  }
  return (
    <div className={cn('flex flex-col', fill ? 'w-full' : kind === 'time' ? 'w-64' : 'w-min')}>
      {kind !== 'time' && (
        <Calendar
          // filling: one day cell = 1/7 of the container (a @container set by the caller)
          className={fill ? 'w-full [--cell-size:calc(100cqw/7)] sm:[--cell-size:calc(100cqw/7)]' : undefined}
          captionLayout="dropdown"
          components={{ Dropdown: CalendarDropdown }}
          endMonth={new Date(thisYear + 50, 11)}
          mode="single"
          month={month}
          onMonthChange={setMonth}
          onSelect={(d) => d && onPick(formatTemporal(kind, typeName, { ...t, date: localDate(d) }))}
          selected={selected}
          startMonth={new Date(1900, 0)}
        />
      )}
      {kind !== 'date' && (
        // w-0 min-w-full: as wide as the calendar, never wider
        <Field className={cn('w-0 min-w-full flex-row items-center gap-3', kind !== 'time' && 'mt-3 border-t pt-3')}>
          <FieldLabel className="whitespace-nowrap">Time</FieldLabel>
          <div className="min-w-0 flex-1">
            <ClockField
              onChange={(time) => onPick(formatTemporal(kind, typeName, { ...t, time, frac: '' }))}
              value={t.time}
            />
          </div>
          {(t.frac || zone) && (
            <span className="shrink-0 font-mono text-muted-foreground text-xs">
              {t.frac}
              {t.frac && zone ? ' ' : ''}
              {zone}
            </span>
          )}
        </Field>
      )}
      <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
        <span className="flex gap-1">
          <Button onClick={() => onPick(nowText(kind, typeName))} size="xs" type="button" variant="outline">
            {kind === 'date' ? 'Today' : 'Now'}
          </Button>
          {kind === 'timestamp' && (
            <Button
              onClick={() =>
                onPick(
                  formatTemporal(kind, typeName, { ...t, date: localDate(new Date()), time: '00:00:00', frac: '' }),
                )
              }
              size="xs"
              type="button"
              variant="outline"
            >
              Today 00:00
            </Button>
          )}
        </span>
        {onDone && (
          <Button onClick={onDone} size="xs" type="button">
            Done
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Text input for dates and times with the picker behind an icon inside the
 * field; typing/pasting stays possible (and keeps full precision), the
 * calendar is there when it is quicker. `inline` shows the picker under the
 * input instead (the large editor).
 */
export function TemporalField({
  kind,
  typeName,
  value,
  onChange,
  onCommit,
  inline = false,
  invalid,
  placeholder,
  size = 'sm',
  autoFocus,
  className,
  onKeyDown,
}: {
  kind: ValueKind
  typeName: string
  value: string
  onChange: (text: string) => void
  /** called when the value is final (blur, Enter, a pick in the calendar) */
  onCommit?: (text: string) => void
  inline?: boolean
  invalid?: boolean
  placeholder?: string
  size?: 'sm' | 'default'
  autoFocus?: boolean
  className?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<HTMLDivElement | null>(null)
  const pick = (text: string) => {
    onChange(text)
    onCommit?.(text)
    if (kind === 'date') setOpen(false)
  }
  const inputProps = {
    'aria-invalid': invalid || undefined,
    autoFocus,
    className: cn('font-mono text-[13px]', className),
    onBlur: () => onCommit?.(value),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') onCommit?.(value)
      if (e.key === 'ArrowDown' && e.altKey && !inline) {
        e.preventDefault()
        setOpen(true)
      }
      onKeyDown?.(e)
    },
    placeholder: placeholder ?? (kind === 'date' ? 'YYYY-MM-DD' : kind === 'time' ? 'HH:MM:SS' : 'YYYY-MM-DD HH:MM:SS'),
    size,
    spellCheck: false,
    value,
  } as const
  if (inline) {
    return (
      <div className="@container flex flex-col gap-4">
        <Input {...inputProps} />
        <TemporalPicker fill kind={kind} onPick={pick} typeName={typeName} value={value} />
      </div>
    )
  }
  return (
    <InputGroup className="min-w-0" ref={setGroup}>
      <InputGroupInput {...inputProps} />
      <InputGroupAddon align="inline-end">
        <Popover onOpenChange={setOpen} open={open}>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      aria-label={kind === 'time' ? 'Pick a time' : 'Pick a date'}
                      className="-me-1"
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    />
                  }
                />
              }
            >
              {kind === 'time' ? <ClockIcon /> : <CalendarIcon />}
            </TooltipTrigger>
            <TooltipPopup>{kind === 'time' ? 'Pick a time' : 'Open the calendar'} (Alt+↓)</TooltipPopup>
          </Tooltip>
          <PopoverPopup align="end" anchor={group} className="w-auto">
            <TemporalPicker kind={kind} onDone={() => setOpen(false)} onPick={pick} typeName={typeName} value={value} />
          </PopoverPopup>
        </Popover>
      </InputGroupAddon>
    </InputGroup>
  )
}

// ---------------------------------------------------------------------------
// booleans
// ---------------------------------------------------------------------------

/**
 * true / false (/ NULL) as one segmented control. Not a switch: a column of type
 * boolean has up to three states plus "not set yet" on a new row, and a switch can
 * only show two, and its "off" would hide whether the value is false, NULL or default.
 */
export function BooleanField({
  value,
  nullable,
  onChange,
  disabled,
  placeholder,
  defaultChoice,
  invalid,
}: {
  /** true / false / null, or undefined when not set (new row: default) */
  value: boolean | null | undefined
  nullable: boolean
  onChange: (value: boolean | null) => void
  disabled?: boolean
  /** shown next to the control when nothing is chosen and the default is an expression */
  placeholder?: string
  /** the column default, when it is a plain true/false: marked on its option while nothing is chosen */
  defaultChoice?: boolean
  invalid?: boolean
}) {
  // remembered so that switching NULL off brings the previous true/false back
  const [lastBool, setLastBool] = useState<boolean>(typeof value === 'boolean' ? value : (defaultChoice ?? false))
  if (typeof value === 'boolean' && value !== lastBool) setLastBool(value)
  const shown = value === undefined ? defaultChoice === true : value === true
  const dimmed = value === null || value === undefined

  let caption: ReactNode
  if (value === null) caption = <span className="font-sans text-muted-foreground text-xs uppercase">NULL</span>
  else if (value === undefined)
    caption =
      defaultChoice !== undefined ? (
        <>
          <span className="text-muted-foreground">{String(defaultChoice)}</span>
          <span className="font-sans text-[10px] text-muted-foreground uppercase">default</span>
        </>
      ) : (
        <span className="text-muted-foreground">{placeholder ?? 'not set'}</span>
      )
  else caption = String(value)

  return (
    <div className="flex min-h-8 items-center gap-3">
      <Label className="min-w-0 flex-1 cursor-pointer gap-2.5 font-mono font-normal text-[13px]">
        <Switch
          aria-invalid={invalid || undefined}
          checked={shown}
          className={cn(dimmed && 'opacity-50', invalid && 'ring-2 ring-destructive/50')}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
        <span className="flex min-w-0 items-center gap-1.5 truncate">{caption}</span>
      </Label>
      {nullable && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label="NULL"
                className="font-normal text-xs"
                disabled={disabled}
                onPressedChange={(pressed) => onChange(pressed ? null : lastBool)}
                pressed={value === null}
                size="sm"
                variant="outline"
              />
            }
          >
            NULL
          </TooltipTrigger>
          <TooltipPopup>{value === null ? 'Back to true / false' : 'Set to NULL (no value)'}</TooltipPopup>
        </Tooltip>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// arrays
// ---------------------------------------------------------------------------

interface Item {
  id: number
  value: string | null
}

// ids of list items, unique for the life of the page; the increment lives outside the components
let nextItemId = 1
const newItemId = () => nextItemId++
const toItems = (values: (string | null)[]): Item[] => values.map((value) => ({ id: newItemId(), value }))

/**
 * One row per array item (typed and validated per item, NULL items explicit),
 * with "Edit as text" for the raw literal. Multi-dimensional arrays stay text.
 */
export function ArrayField({
  typeName,
  value,
  onCommit,
  onChange,
  placeholder,
}: {
  typeName: string
  /** array literal, or null for NULL */
  value: string | null
  /** final changes (blur, add / remove / move) */
  onCommit: (literal: string | null) => void
  /** every keystroke too, for editors that keep their own draft */
  onChange?: (literal: string | null) => void
  placeholder?: string
}) {
  const element = elementTypeName(typeName)
  const elementSpec: ValueSpec = { kind: kindFromTypeName(element), typeName: element }
  const parsed = value === null ? [] : parsePgArray(value)
  const [asText, setAsText] = useState(parsed === null)
  const [items, setItems] = useState<Item[]>(() => toItems(parsed ?? []))
  const [text, setText] = useState(value ?? '')
  const focusId = useRef<number | null>(null)
  const listId = useId()

  // follow outside changes (revert, undo, another row)
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    const p = value === null ? [] : parsePgArray(value)
    setText(value ?? '')
    if (p === null) setAsText(true)
    else setItems((current) => (toPgArray(current.map((i) => i.value)) === toPgArray(p) ? current : toItems(p)))
  }

  useEffect(() => {
    if (focusId.current === null) return
    document.getElementById(`${listId}-${focusId.current}`)?.focus()
    focusId.current = null
  })

  const commitItems = (next: Item[]) => {
    setItems(next)
    onCommit(toPgArray(next.map((i) => i.value)))
  }

  if (asText) {
    return (
      <div className="flex flex-col gap-1.5">
        <Textarea
          className="font-mono text-[13px]"
          onBlur={() => text !== (value ?? '') && onCommit(text === '' ? null : text)}
          onChange={(e) => {
            setText(e.target.value)
            onChange?.(e.target.value === '' ? null : e.target.value)
          }}
          placeholder={placeholder ?? '{a,b,c}'}
          rows={2}
          spellCheck={false}
          value={text}
        />
        {parsePgArray(text || '{}') !== null && (
          <Button className="self-start" onClick={() => setAsText(false)} size="xs" type="button" variant="ghost">
            Edit as list
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {value === null && (
        <p className="text-muted-foreground text-xs">{placeholder ?? 'NULL'}. Add an item to start a list.</p>
      )}
      {items.length === 0 && value !== null && <p className="text-muted-foreground text-xs">Empty array</p>}
      <ol className="flex flex-col gap-1">
        {items.map((item, i) => {
          const problem = item.value === null || item.value === '' ? null : checkText(item.value, elementSpec)
          return (
            <li className="flex flex-col gap-0.5" key={item.id}>
              <div className="flex items-center gap-1">
                <span className="w-5 shrink-0 text-end font-mono text-[11px] text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <Input
                  aria-invalid={problem ? true : undefined}
                  aria-label={`Item ${i + 1}`}
                  className="font-mono text-[13px]"
                  disabled={item.value === null}
                  id={`${listId}-${item.id}`}
                  onBlur={() => onCommit(toPgArray(items.map((x) => x.value)))}
                  onChange={(e) => {
                    const next = items.map((x) => (x.id === item.id ? { ...x, value: e.target.value } : x))
                    setItems(next)
                    onChange?.(toPgArray(next.map((x) => x.value)))
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault()
                      const added = { id: newItemId(), value: '' }
                      focusId.current = added.id
                      commitItems([...items.slice(0, i + 1), added, ...items.slice(i + 1)])
                    }
                    if (e.key === 'Backspace' && item.value === '' && items.length > 1) {
                      e.preventDefault()
                      focusId.current = items[Math.max(0, i - 1)]!.id
                      commitItems(items.filter((x) => x.id !== item.id))
                    }
                  }}
                  placeholder={item.value === null ? 'NULL' : ''}
                  size="sm"
                  spellCheck={false}
                  value={item.value ?? ''}
                />
                <span className="flex shrink-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label={item.value === null ? 'Give the item a value' : 'Make the item NULL'}
                          onClick={() =>
                            commitItems(
                              items.map((x) => (x.id === item.id ? { ...x, value: x.value === null ? '' : null } : x)),
                            )
                          }
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        />
                      }
                    >
                      {item.value === null ? <TextCursorInputIcon /> : <CircleSlashIcon />}
                    </TooltipTrigger>
                    <TooltipPopup>{item.value === null ? 'Give it a value' : 'Make it NULL'}</TooltipPopup>
                  </Tooltip>
                  <Button
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => commitItems([...items.slice(0, i - 1), item, items[i - 1]!, ...items.slice(i + 1)])}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    aria-label="Move down"
                    disabled={i === items.length - 1}
                    onClick={() => commitItems([...items.slice(0, i), items[i + 1]!, item, ...items.slice(i + 2)])}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    aria-label="Remove item"
                    onClick={() => commitItems(items.filter((x) => x.id !== item.id))}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </span>
              </div>
              {problem && <p className="ps-6 text-destructive-foreground text-xs">{problem}</p>}
            </li>
          )
        })}
      </ol>
      <div className="flex gap-1">
        <Button
          onClick={() => {
            const added = { id: newItemId(), value: '' }
            focusId.current = added.id
            commitItems([...items, added])
          }}
          size="xs"
          type="button"
          variant="ghost"
        >
          <PlusIcon aria-hidden="true" />
          Add item
        </Button>
        <Button onClick={() => setAsText(true)} size="xs" type="button" variant="ghost">
          Edit as text
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// foreign keys
// ---------------------------------------------------------------------------

/**
 * Input for a foreign key that suggests rows of the referenced table (key and a
 * readable column such as name or email). Typing a key directly still works.
 */
export function ForeignKeyField({
  fk,
  value,
  onChange,
  onCommit,
  placeholder,
  invalid,
  autoFocus,
  className,
  size = 'sm',
  onKeyDown,
  defaultOpen = false,
}: {
  fk: { schema: string; table: string; column: string }
  value: string
  onChange: (text: string) => void
  onCommit?: (text: string) => void
  placeholder?: string
  invalid?: boolean
  autoFocus?: boolean
  className?: string
  size?: 'sm' | 'default'
  /** called for keys the picker does not use itself (Enter only when no suggestion is highlighted) */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  /** start with the suggestions showing (editing a grid cell) */
  defaultOpen?: boolean
}) {
  const target = useContext(LookupContext)
  const [open, setOpen] = useState(defaultOpen)
  const [search, setSearch] = useState('')
  const highlighted = useRef<ReferenceOption | undefined>(undefined)
  // opened for editing: browse every row until something is typed (not just the current key)
  const initial = useRef(value)
  useEffect(() => {
    if (defaultOpen && value === initial.current) return
    const t = setTimeout(() => setSearch(value), 200)
    return () => clearTimeout(t)
  }, [value, defaultOpen])
  const q = useQuery({
    ...referenceQuery(target?.connectionId ?? '', target?.database ?? '', fk, search),
    enabled: Boolean(target) && open,
  })
  const items = q.data?.items ?? []

  return (
    <Autocomplete
      filter={null}
      itemToStringValue={(o: ReferenceOption) => o.value}
      items={items}
      onItemHighlighted={(item) => {
        highlighted.current = item as ReferenceOption | undefined
      }}
      defaultOpen={defaultOpen}
      onOpenChange={setOpen}
      onValueChange={(v, details) => {
        onChange(v)
        if (details.reason === 'item-press') onCommit?.(v)
      }}
      openOnInputClick
      value={value}
    >
      <AutocompleteInput
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        className={cn('font-mono text-[13px]', className)}
        onBlur={() => onCommit?.(value)}
        // typing replaces the current key, like any cell editor
        onFocus={defaultOpen ? (e) => e.currentTarget.select() : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && open && highlighted.current) return
          onKeyDown?.(e)
        }}
        placeholder={placeholder}
        size={size}
        spellCheck={false}
      />
      <AutocompletePopup className="min-w-80">
        <div className="border-b px-3 py-1.5 text-muted-foreground text-xs">
          {fk.table}
          {q.data?.labelColumn
            ? ` · ${fk.column}, ${q.data.labelColumn}${q.data.detailColumn ? `, ${q.data.detailColumn}` : ''}`
            : ` · ${fk.column}`}
        </div>
        <AutocompleteEmpty>{q.isFetching ? 'Searching…' : 'No matching rows'}</AutocompleteEmpty>
        <AutocompleteList>
          {(o: ReferenceOption) => (
            <AutocompleteItem className="gap-3" key={o.value} value={o}>
              <span className="min-w-10 shrink-0 font-mono text-[13px] tabular-nums">{o.value}</span>
              {o.label !== null && <span className="min-w-0 truncate">{o.label}</span>}
              {o.detail != null && (
                <span className="ms-auto min-w-0 shrink truncate text-muted-foreground text-xs">{o.detail}</span>
              )}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  )
}

export function FieldProblem({ children, id }: { children: ReactNode; id?: string }) {
  if (!children) return null
  return (
    <p className="text-destructive-foreground text-xs" id={id} role="alert">
      {children}
    </p>
  )
}
