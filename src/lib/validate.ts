/**
 * Client-side checks for values typed into the grid, the row panel, the value
 * editor and the filter popover: the same rules everywhere, before anything is
 * sent to PostgreSQL. They are deliberately a bit lenient: when PostgreSQL could
 * accept an input we cannot fully judge here, it passes and the server decides.
 */
import { parsePgArray } from './pg-array'
import type { ValueKind } from './types'

export interface ValueSpec {
  kind: ValueKind
  /** short type name, e.g. "int4", "varchar", "timestamptz", "text[]" */
  typeName: string
  /** formatted type with modifiers, e.g. "character varying(80)", "numeric(10,2)" */
  fullType?: string | null
  nullable?: boolean
  hasDefault?: boolean
  readOnly?: boolean
  enumValues?: string[] | null
}

const INT_RANGES: Record<string, [bigint, bigint]> = {
  int2: [-32768n, 32767n],
  smallint: [-32768n, 32767n],
  int4: [-2147483648n, 2147483647n],
  integer: [-2147483648n, 2147483647n],
  int: [-2147483648n, 2147483647n],
  int8: [-9223372036854775808n, 9223372036854775807n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
}

const DATE_WORDS = new Set(['today', 'tomorrow', 'yesterday', 'infinity', '-infinity', 'epoch', 'now'])
const UUID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i
const ISO_DATE = /^(\d{4,})-(\d{1,2})-(\d{1,2})( BC)?$/i
const ISO_TIMESTAMP =
  /^(\d{4,})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?\s*(?:Z|[+-]\d{1,2}(?::?\d{2})?)?( BC)?$/i
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?\s*(?:Z|[+-]\d{1,2}(?::?\d{2})?)?$/i
const INTERVAL_UNITS =
  '(?:microseconds?|us|milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mons?|years?|yrs?|y|decades?|centur(?:y|ies)|millenni(?:um|a))'
const INTERVAL_WORDS = new RegExp(
  `^@?\\s*(?:[+-]?\\d+(?:\\.\\d+)?\\s*${INTERVAL_UNITS}\\s*,?\\s*)+(?:[+-]?\\d{1,}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)?\\s*(?:ago)?$`,
  'i',
)
const INTERVAL_CLOCK = /^[+-]?\d+:\d{2}(:\d{2}(\.\d+)?)?$/
const INTERVAL_ISO =
  /^P(?!$)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/i

/** Base type of an array type name: "text[]" / "_text" → "text". */
export function elementTypeName(typeName: string): string {
  return typeName.endsWith('[]') ? typeName.slice(0, -2) : typeName.startsWith('_') ? typeName.slice(1) : typeName
}

/** Kind of a type by name, for array elements (whose kind is not reported separately). */
export function kindFromTypeName(name: string): ValueKind {
  const n = name.toLowerCase()
  if (n in INT_RANGES || /^(numeric|decimal|float4|float8|real|double precision|money|oid)/.test(n)) return 'number'
  if (n === 'bool' || n === 'boolean') return 'boolean'
  if (n === 'json' || n === 'jsonb') return 'json'
  if (n === 'uuid') return 'uuid'
  if (n === 'date') return 'date'
  if (n === 'time' || n === 'timetz' || n.startsWith('time ')) return 'time'
  if (n.startsWith('timestamp')) return 'timestamp'
  if (n === 'interval') return 'interval'
  if (n === 'inet' || n === 'cidr') return 'network'
  if (n === 'bytea') return 'binary'
  return 'text'
}

function realDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  // not via Date: PostgreSQL dates go far beyond the years JavaScript can represent
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31
  return d <= days
}

function checkInteger(text: string, typeName: string): string | null {
  if (!/^[+-]?\d+$/.test(text)) return 'Must be a whole number'
  const range = INT_RANGES[typeName]
  if (range) {
    const n = BigInt(text)
    if (n < range[0] || n > range[1]) return `Out of range for ${typeName} (${range[0]} to ${range[1]})`
  }
  return null
}

function checkNumber(text: string, typeName: string, fullType?: string | null): string | null {
  const t = typeName.toLowerCase()
  if (t in INT_RANGES) return checkInteger(text, t)
  if (/^(nan|[+-]?infinity)$/i.test(text) && !t.startsWith('money')) return null
  if (t === 'money') return /^[+-]?[$€£]?\s*[\d,]+(\.\d+)?$/.test(text) ? null : 'Must be an amount, e.g. 12.50'
  if (!NUMBER.test(text)) return 'Must be a number, e.g. 12.5'
  const m = fullType ? /numeric\((\d+)(?:,\s*(\d+))?\)/i.exec(fullType) : null
  if (m) {
    const precision = Number(m[1])
    const scale = Number(m[2] ?? 0)
    const digits = text.replace(/^[+-]/, '').split(/e/i)[0]!.split('.')[0]!.replace(/^0+/, '')
    if (digits.length > precision - scale) {
      return `Too large for numeric(${precision},${scale}): at most ${precision - scale} digits before the decimal point`
    }
  }
  return null
}

function checkDate(text: string): string | null {
  if (DATE_WORDS.has(text.toLowerCase())) return null
  const m = ISO_DATE.exec(text)
  if (m) return realDate(Number(m[1]), Number(m[2]), Number(m[3])) ? null : 'This date does not exist'
  return Number.isNaN(Date.parse(text)) ? 'Not a valid date. Use YYYY-MM-DD' : null
}

function checkTimestamp(text: string): string | null {
  if (DATE_WORDS.has(text.toLowerCase())) return null
  const m = ISO_TIMESTAMP.exec(text)
  if (m) {
    if (!realDate(Number(m[1]), Number(m[2]), Number(m[3]))) return 'This date does not exist'
    if (m[4] !== undefined && (Number(m[4]) > 24 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 60))
      return 'This time does not exist'
    return null
  }
  return Number.isNaN(Date.parse(text)) ? 'Not a valid date and time. Use YYYY-MM-DD HH:MM:SS' : null
}

function checkTime(text: string): string | null {
  if (/^(now|allballs)$/i.test(text)) return null
  const m = TIME.exec(text)
  if (!m) return 'Not a valid time. Use HH:MM or HH:MM:SS'
  if (Number(m[1]) > 24 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 60) return 'This time does not exist'
  return null
}

function checkInterval(text: string): string | null {
  return INTERVAL_WORDS.test(text) || INTERVAL_CLOCK.test(text) || INTERVAL_ISO.test(text)
    ? null
    : 'Not a valid interval, e.g. 2 days, 01:30:00 or P1DT2H'
}

function checkNetwork(text: string, typeName: string): string | null {
  if (typeName === 'macaddr' || typeName === 'macaddr8') {
    const bytes = typeName === 'macaddr' ? 6 : 8
    const hex = text.replace(/[:.-]/g, '')
    return /^[0-9a-f]+$/i.test(hex) && (hex.length === bytes * 2 || (bytes === 8 && hex.length === 12))
      ? null
      : `Not a valid MAC address, e.g. 08:00:2b:01:02:03`
  }
  const [addr, bits, ...rest] = text.split('/')
  if (rest.length || addr === undefined) return 'Not a valid IP address'
  if (/^\d+(\.\d+){3}$/.test(addr)) {
    if (addr.split('.').some((o) => Number(o) > 255)) return 'Each part of an IPv4 address is 0–255'
    if (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= 32)) return 'Prefix length is 0–32'
    return null
  }
  if (/^[0-9a-f:.]+$/i.test(addr) && addr.includes(':') && (addr.match(/::/g)?.length ?? 0) <= 1) {
    if (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= 128)) return 'Prefix length is 0–128'
    return null
  }
  return typeName === 'cidr' ? 'Not a valid network, e.g. 10.0.0.0/24' : 'Not a valid IP address, e.g. 10.0.0.1'
}

function maxLength(fullType?: string | null): number | null {
  const m = fullType
    ? /^(?:character varying|varchar|character|char|bpchar|bit varying|bit)\((\d+)\)/i.exec(fullType)
    : null
  return m ? Number(m[1]) : null
}

/** Problem with a non-empty text value of the given type, or null when it looks fine. */
export function checkText(text: string, spec: ValueSpec): string | null {
  const t = text.trim()
  switch (spec.kind) {
    case 'number':
      return checkNumber(t, spec.typeName, spec.fullType)
    case 'boolean':
      return /^(t|f|true|false|y|n|yes|no|on|off|1|0)$/i.test(t) ? null : 'Must be true or false'
    case 'json':
      try {
        JSON.parse(text)
        return null
      } catch (err) {
        return `Invalid JSON: ${(err as Error).message}`
      }
    case 'uuid':
      return UUID.test(t) ? null : 'Not a valid UUID, e.g. 123e4567-e89b-12d3-a456-426614174000'
    case 'date':
      return checkDate(t)
    case 'timestamp':
      return checkTimestamp(t)
    case 'time':
      return checkTime(t)
    case 'interval':
      return checkInterval(t)
    case 'network':
      return checkNetwork(t, spec.typeName)
    case 'enum':
      return spec.enumValues?.length && !spec.enumValues.includes(text)
        ? `Must be one of: ${spec.enumValues.join(', ')}`
        : null
    case 'binary':
      return /^\\x([0-9a-f]{2})*$/i.test(t) || !t.startsWith('\\x') ? null : 'Write bytes as hex, like \\x0a1b…'
    case 'array': {
      const items = parsePgArray(t)
      if (!items) return /^\{.*\}$/s.test(t) ? null : 'Not a valid list, e.g. {a,b,c}' // nested arrays: left to the server
      const element = elementTypeName(spec.typeName)
      const elementSpec: ValueSpec = { kind: kindFromTypeName(element), typeName: element }
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item === null) continue
        const problem = checkText(item, elementSpec)
        if (problem) return `Item ${i + 1}: ${problem}`
      }
      return null
    }
    default: {
      const max = maxLength(spec.fullType)
      if (max !== null && text.length > max) return `Too long: ${text.length} characters, the limit is ${max}`
      return null
    }
  }
}

/**
 * Problem with a cell value before it is saved, or null.
 * `value` is what the editors stage: a string, boolean, null, or undefined / DEFAULT for new rows.
 */
export function validateValue(
  value: string | boolean | null | undefined | { default: true },
  spec: ValueSpec,
  opts: { isNew?: boolean } = {},
): string | null {
  if (value === undefined || (typeof value === 'object' && value !== null)) {
    if (opts.isNew && !spec.nullable && !spec.hasDefault && !spec.readOnly) return 'Required'
    return null
  }
  if (value === null) return spec.nullable === false ? 'Cannot be NULL' : null
  if (typeof value === 'boolean') return null
  if (value === '' && spec.kind !== 'text' && spec.kind !== 'other' && spec.kind !== 'binary') {
    return spec.nullable === false ? 'Required' : 'Empty. Use NULL to leave it blank'
  }
  if (value === '') return null
  return checkText(value, spec)
}
