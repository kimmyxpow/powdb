import { memo } from 'react'
import { parsePgArray } from '@/lib/pg-array'
import { displayTemporal } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { GridColumn, GridValue } from './types'
import { isDefaultMarker } from './types'

const MAX_RENDER = 240

export const CellContent = memo(function CellContent({
  value,
  column,
}: {
  value: GridValue | undefined
  column: GridColumn
}) {
  if (value === undefined || isDefaultMarker(value)) {
    // what an empty cell of a new row becomes on save
    const required = !column.hasDefault && !column.readOnly && column.nullable === false
    return (
      <span
        className={cn('font-sans text-xs italic', required ? 'text-warning-foreground' : 'text-muted-foreground/70')}
      >
        {column.hasDefault || column.readOnly ? 'default' : required ? 'required' : 'null'}
      </span>
    )
  }
  if (value === null) {
    return (
      <span className="font-medium font-sans text-[0.68rem] text-muted-foreground/55 uppercase tracking-wider">
        null
      </span>
    )
  }
  if (typeof value === 'boolean') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn('size-1.5 rounded-full', value ? 'bg-success' : 'bg-muted-foreground/40')}
        />
        <span className={value ? '' : 'text-muted-foreground'}>{value ? 'true' : 'false'}</span>
      </span>
    )
  }
  if (value === '') {
    return <span className="font-sans text-muted-foreground/45 text-xs italic">empty</span>
  }
  if ((column.kind === 'timestamp' || column.kind === 'time') && column.timeDisplay) {
    return <>{displayTemporal(value, column.typeName, column.timeDisplay)}</>
  }
  if (column.foreignKey && column.refLabels) {
    const ref = column.refLabels.get(value)
    return (
      <>
        {value}
        {ref?.label != null && <span className="ms-2 font-sans text-muted-foreground">{ref.label}</span>}
      </>
    )
  }
  let text = value.length > MAX_RENDER ? `${value.slice(0, MAX_RENDER)}…` : value
  if (column.kind === 'json') text = text.replace(/\s*\n\s*/g, ' ')
  else text = text.replace(/\r?\n/g, ' ↵ ')

  if (column.kind === 'array') {
    const items = parsePgArray(value)
    if (items) {
      if (items.length === 0) {
        return <span className="font-sans text-muted-foreground/60 text-xs italic">empty</span>
      }
      return (
        <span className="inline-flex items-center gap-1">
          {items.slice(0, 8).map((item, i) => (
            <span
              className={cn(
                'rounded-[0.3rem] bg-muted px-1.5 py-px font-sans text-xs',
                item === null && 'text-muted-foreground/70 uppercase',
              )}
              key={i}
            >
              {item === null ? 'null' : item.length > 40 ? `${item.slice(0, 40)}…` : item}
            </span>
          ))}
          {items.length > 8 && <span className="font-sans text-muted-foreground text-xs">+{items.length - 8}</span>}
        </span>
      )
    }
  }
  if (column.kind === 'enum') {
    return <span className="rounded-[0.3rem] bg-muted px-1.5 py-px font-sans text-xs">{text}</span>
  }
  if (column.kind === 'json') {
    return <span className="text-foreground/85">{text}</span>
  }
  return <>{text}</>
})
