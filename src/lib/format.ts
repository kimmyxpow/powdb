import type { Cell, RelationKind } from './types'

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('en')

export function formatCount(n: number | null | undefined, opts?: { compact?: boolean }): string {
  if (n == null) return 'Unknown'
  return opts?.compact && n >= 10_000 ? compact.format(n) : full.format(n)
}

/** "1 row", "2 rows", "12,400 rows" (or "12.4K rows" when compact) */
export function countLabel(n: number, singular: string, opts?: { compact?: boolean }): string {
  return `${formatCount(n, opts)} ${n === 1 ? singular : `${singular}s`}`
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return 'never'
  const date = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(date)) return String(iso)
  const diff = Date.now() - date
  const sec = Math.round(diff / 1000)
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(date).toLocaleDateString()
}

const RELATION_KIND_LABELS: Record<RelationKind, string> = {
  r: 'Table',
  p: 'Partitioned table',
  v: 'View',
  m: 'Materialized view',
  f: 'Foreign table',
}

export function relationKindLabel(kind: RelationKind): string {
  return RELATION_KIND_LABELS[kind]
}

/** Text representation of a cell (for copy / export / editing). */
export function cellToText(value: Cell): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return value
}
