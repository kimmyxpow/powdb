import { cellToText } from './format'
import { displayIdent, quoteLiteral } from './sql'
import type { Cell, ValueKind } from './types'

export interface ExportField {
  name: string
  kind: ValueKind
}

export function uniqueNames(fields: ExportField[]): string[] {
  const seen = new Map<string, number>()
  return fields.map((f) => {
    const n = seen.get(f.name) ?? 0
    seen.set(f.name, n + 1)
    return n === 0 ? f.name : `${f.name}_${n + 1}`
  })
}

export function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function toCsv(fields: ExportField[], rows: Cell[][]): string {
  const lines = [fields.map((f) => csvEscape(f.name)).join(',')]
  for (const row of rows) lines.push(row.map((v) => csvEscape(cellToText(v))).join(','))
  return lines.join('\n') + '\n'
}

export function toTsv(fields: ExportField[] | null, rows: Cell[][]): string {
  const clean = (v: Cell) => cellToText(v).replace(/[\t\n\r]+/g, ' ')
  const lines = fields ? [fields.map((f) => f.name).join('\t')] : []
  for (const row of rows) lines.push(row.map(clean).join('\t'))
  return lines.join('\n')
}

export function jsonValue(value: Cell, kind: ValueKind): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (kind === 'json') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  if (kind === 'number' && /^-?\d+(\.\d+)?$/.test(value) && Number.isSafeInteger(Math.trunc(Number(value)))) {
    return Number(value)
  }
  return value
}

export function rowToObject(fields: ExportField[], row: Cell[]): Record<string, unknown> {
  const names = uniqueNames(fields)
  const obj: Record<string, unknown> = {}
  names.forEach((name, i) => {
    obj[name] = jsonValue(row[i] ?? null, fields[i]!.kind)
  })
  return obj
}

function toJson(fields: ExportField[], rows: Cell[][]): string {
  return (
    JSON.stringify(
      rows.map((r) => rowToObject(fields, r)),
      null,
      2,
    ) + '\n'
  )
}

export function sqlValue(value: Cell, kind: ValueKind): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (kind === 'number' && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)) return value
  return quoteLiteral(value)
}

function toSqlInserts(table: string, fields: ExportField[], rows: Cell[][]): string {
  if (rows.length === 0) return `-- no rows\n`
  const cols = fields.map((f) => displayIdent(f.name)).join(', ')
  return (
    rows
      .map(
        (r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => sqlValue(v, fields[i]!.kind)).join(', ')});`,
      )
      .join('\n') + '\n'
  )
}

function toMarkdown(fields: ExportField[], rows: Cell[][]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const head = `| ${fields.map((f) => esc(f.name)).join(' | ')} |`
  const sep = `| ${fields.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map((v) => (v === null ? 'NULL' : esc(cellToText(v)))).join(' | ')} |`)
  return [head, sep, ...body].join('\n') + '\n'
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Copies text. Resolves to false when the browser blocked both ways of copying. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyWithTextarea(text)
  }
}

function copyWithTextarea(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  try {
    ta.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
  }
}

export type ExportFormat = 'csv' | 'json' | 'sql' | 'md'

export function exportRows(
  format: ExportFormat,
  baseName: string,
  table: string,
  fields: ExportField[],
  rows: Cell[][],
) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const name = `${baseName}-${stamp}`
  switch (format) {
    case 'csv':
      return downloadFile(`${name}.csv`, toCsv(fields, rows), 'text/csv')
    case 'json':
      return downloadFile(`${name}.json`, toJson(fields, rows), 'application/json')
    case 'sql':
      return downloadFile(`${name}.sql`, toSqlInserts(table, fields, rows), 'application/sql')
    case 'md':
      return downloadFile(`${name}.md`, toMarkdown(fields, rows), 'text/markdown')
  }
}
