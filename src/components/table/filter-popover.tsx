import { ListFilterIcon, PlusIcon, XIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BooleanField, TemporalField, isTemporal } from '@/components/grid/value-editors'
import type { Filter, FilterOperator, ValueKind } from '@/lib/types'
import { checkText } from '@/lib/validate'

type OperatorGroup = 'Compare' | 'Text' | 'List' | 'Empty'

const OPERATORS: {
  value: FilterOperator
  label: string
  chip: string
  group: OperatorGroup
  needsValue: boolean
}[] = [
  { value: 'eq', label: 'equals', chip: '=', group: 'Compare', needsValue: true },
  { value: 'neq', label: 'not equal to', chip: '≠', group: 'Compare', needsValue: true },
  { value: 'gt', label: 'greater than', chip: '>', group: 'Compare', needsValue: true },
  { value: 'gte', label: 'greater than or equal', chip: '≥', group: 'Compare', needsValue: true },
  { value: 'lt', label: 'less than', chip: '<', group: 'Compare', needsValue: true },
  { value: 'lte', label: 'less than or equal', chip: '≤', group: 'Compare', needsValue: true },
  { value: 'contains', label: 'contains', chip: 'contains', group: 'Text', needsValue: true },
  { value: 'not_contains', label: 'does not contain', chip: 'not contains', group: 'Text', needsValue: true },
  { value: 'starts_with', label: 'starts with', chip: 'starts with', group: 'Text', needsValue: true },
  { value: 'ends_with', label: 'ends with', chip: 'ends with', group: 'Text', needsValue: true },
  { value: 'in', label: 'is one of', chip: 'in', group: 'List', needsValue: true },
  { value: 'is_null', label: 'is NULL', chip: 'is NULL', group: 'Empty', needsValue: false },
  { value: 'not_null', label: 'is not NULL', chip: 'is not NULL', group: 'Empty', needsValue: false },
]

const OPERATOR_GROUPS: OperatorGroup[] = ['Compare', 'Text', 'List', 'Empty']
const TEXT_OPS: ReadonlySet<FilterOperator> = new Set(['contains', 'not_contains', 'starts_with', 'ends_with'])

function valuePlaceholder(kind: ValueKind): string {
  switch (kind) {
    case 'number':
      return 'e.g. 100'
    case 'uuid':
      return 'uuid'
    case 'interval':
      return 'e.g. 2 days'
    case 'network':
      return 'e.g. 10.0.0.1'
    default:
      return 'value'
  }
}

const opInfo = (op: FilterOperator) => OPERATORS.find((o) => o.value === op)!

/** A condition in the draft. `rowId` is only for React keys and is never sent to the server. */
type DraftFilter = Filter & { rowId: string }

const withRowIds = (list: Filter[]): DraftFilter[] => list.map((f) => ({ ...f, rowId: crypto.randomUUID() }))

function defaultOp(kind: ValueKind | undefined): FilterOperator {
  return kind === 'text' || kind === 'json' ? 'contains' : 'eq'
}

interface FilterColumn {
  name: string
  kind: ValueKind
  typeName: string
  enumValues?: string[] | null
}

export function describeFilter(f: Filter): string {
  const info = opInfo(f.op)
  if (!info.needsValue) return `${f.column} ${info.chip}`
  return `${f.column} ${info.chip} ${f.value ?? ''}`
}

export function FilterPopover({
  columns,
  filters,
  where,
  onApply,
  open,
  onOpenChange,
  startColumn,
}: {
  columns: FilterColumn[]
  filters: Filter[]
  where: string | undefined
  onApply: (filters: Filter[], where: string | undefined) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * column for a new condition when the popover opens: the selected cell's column, or the
   * column whose header menu asked for a filter (`add`: also when other filters exist)
   */
  startColumn?: { name: string; add?: boolean } | null
}) {
  const [draft, setDraft] = useState<DraftFilter[]>(() => withRowIds(filters))
  const [draftWhere, setDraftWhere] = useState(where ?? '')

  // the draft starts again from the applied filters when the popover opens
  // (during render, so the popover never shows the previous draft for a frame)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      const start = columns.find((c) => c.name === startColumn?.name) ?? columns[0]
      const fresh = start
        ? [{ rowId: crypto.randomUUID(), column: start.name, op: defaultOp(start.kind), value: '' }]
        : []
      setDraft(
        filters.length
          ? startColumn?.add && start && !filters.some((f) => f.column === start.name)
            ? [...withRowIds(filters), ...fresh]
            : withRowIds(filters)
          : fresh,
      )
      setDraftWhere(where ?? '')
    }
  }

  const update = (index: number, patch: Partial<Filter>) =>
    setDraft((d) => d.map((f, i) => (i === index ? { ...f, ...patch } : f)))

  const apply = () => {
    if (hasProblems) return
    const clean = draft
      .filter((f) => !opInfo(f.op).needsValue || (f.value ?? '') !== '')
      .map(({ rowId: _rowId, ...f }) => f)
    onApply(clean, draftWhere.trim() || undefined)
    onOpenChange(false)
  }

  // same value checks as the editors, for comparisons (text matching takes anything)
  const problems = draft.map((f) => {
    const col = columns.find((c) => c.name === f.column)
    const info = opInfo(f.op)
    if (!col || !info.needsValue || !f.value || TEXT_OPS.has(f.op) || col.kind === 'json' || col.kind === 'array')
      return null
    const spec = { kind: col.kind, typeName: col.typeName, enumValues: col.enumValues }
    const parts =
      f.op === 'in'
        ? f.value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : [f.value]
    for (const part of parts) {
      const problem = checkText(part, spec)
      if (problem) return parts.length > 1 ? `"${part}": ${problem}` : problem
    }
    return null
  })
  const hasProblems = problems.some(Boolean)

  const count = filters.length + (where ? 1 : 0)
  const columnItems = columns.map((c) => ({ label: c.name, value: c.name }))
  const opItems = OPERATORS.map((o) => ({ label: o.label, value: o.value }))

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger render={<Button size="sm" variant={count ? 'secondary' : 'outline'} />}>
        <ListFilterIcon aria-hidden="true" />
        Filter
        {count > 0 && (
          <Badge className="-me-1 tabular-nums" size="sm">
            {count}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[min(40rem,calc(100vw-2rem))]">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Filters</span>
            <span className="text-muted-foreground text-xs">All conditions must match</span>
          </div>
          {draft.length === 0 && (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground text-sm">
              No filters. Add one below.
            </p>
          )}
          {draft.map((f, i) => {
            const col = columns.find((c) => c.name === f.column)
            const info = opInfo(f.op)
            return (
              <div className="flex flex-col gap-1" key={f.rowId}>
                <div className="grid grid-cols-[minmax(0,1fr)_11rem_minmax(0,1.2fr)_auto] items-center gap-2">
                  <Select
                    items={columnItems}
                    onValueChange={(v) => {
                      const next = columns.find((c) => c.name === v)
                      update(i, { column: v as string, op: defaultOp(next?.kind) })
                    }}
                    value={f.column}
                  >
                    <SelectTrigger aria-label="Column" className="min-w-0 font-mono text-xs" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false} className="min-w-56">
                      {columns.map((c) => (
                        <SelectItem key={c.name} value={c.name}>
                          <span className="flex items-center justify-between gap-6">
                            <span className="truncate font-mono text-xs">{c.name}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.typeName}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Select items={opItems} onValueChange={(v) => update(i, { op: v as FilterOperator })} value={f.op}>
                    <SelectTrigger aria-label="Operator" className="min-w-0" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false} className="min-w-48">
                      {OPERATOR_GROUPS.map((group, gi) => (
                        <Fragment key={group}>
                          {gi > 0 && <SelectSeparator />}
                          <SelectGroup>
                            <SelectGroupLabel>{group}</SelectGroupLabel>
                            {OPERATORS.filter((o) => o.group === group).map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </Fragment>
                      ))}
                    </SelectPopup>
                  </Select>
                  {info.needsValue ? (
                    col?.enumValues?.length && (f.op === 'eq' || f.op === 'neq') ? (
                      <Select
                        items={col.enumValues.map((v) => ({ label: v, value: v }))}
                        onValueChange={(v) => update(i, { value: v as string })}
                        value={f.value || null}
                      >
                        <SelectTrigger aria-label="Value" className="min-w-0 font-mono text-xs" size="sm">
                          <SelectValue placeholder="Choose…" />
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {col.enumValues.map((v) => (
                            <SelectItem className="font-mono text-xs" key={v} value={v}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : col?.kind === 'boolean' && (f.op === 'eq' || f.op === 'neq') ? (
                      <BooleanField
                        nullable={false}
                        onChange={(v) => update(i, { value: String(v) })}
                        value={f.value === 'true' ? true : f.value === 'false' ? false : undefined}
                      />
                    ) : col && isTemporal(col.kind) && f.op !== 'in' && !TEXT_OPS.has(f.op) ? (
                      <TemporalField
                        className="text-xs"
                        invalid={Boolean(problems[i])}
                        kind={col.kind}
                        onChange={(v) => update(i, { value: v })}
                        typeName={col.typeName}
                        value={f.value ?? ''}
                      />
                    ) : (
                      <Input
                        aria-invalid={problems[i] ? true : undefined}
                        aria-label="Value"
                        autoFocus={i === draft.length - 1}
                        className="font-mono text-xs"
                        inputMode={col?.kind === 'number' && f.op !== 'in' ? 'decimal' : undefined}
                        onChange={(e) => update(i, { value: e.target.value })}
                        placeholder={f.op === 'in' ? 'a, b, c' : col ? valuePlaceholder(col.kind) : 'value'}
                        size="sm"
                        spellCheck={false}
                        value={f.value ?? ''}
                      />
                    )
                  ) : (
                    <span />
                  )}
                  <Button
                    aria-label="Remove filter"
                    onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </div>
                {problems[i] && <p className="text-destructive-foreground text-xs">{problems[i]}</p>}
              </div>
            )
          })}
          <div>
            <Button
              onClick={() =>
                setDraft((d) => [
                  ...d,
                  {
                    rowId: crypto.randomUUID(),
                    column: columns[0]?.name ?? '',
                    op: defaultOp(columns[0]?.kind),
                    value: '',
                  },
                ])
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              <PlusIcon aria-hidden="true" />
              Add filter
            </Button>
          </div>
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Label htmlFor="where-clause">
              SQL condition <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              className="font-mono text-xs"
              id="where-clause"
              onChange={(e) => setDraftWhere(e.target.value)}
              placeholder="e.g. total > 100 AND placed_at > now() - interval '7 days'"
              size="sm"
              spellCheck={false}
              value={draftWhere}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button
              disabled={!draft.length && !draftWhere}
              onClick={() => {
                setDraft([])
                setDraftWhere('')
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear all
            </Button>
            <Button disabled={hasProblems} size="sm" type="submit">
              Apply filters
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  )
}
