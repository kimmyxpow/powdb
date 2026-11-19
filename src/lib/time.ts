/**
 * Showing PostgreSQL date/time text the way a person reads it: timestamptz in the
 * browser's time zone (PostgreSQL sends it in the session zone, usually UTC), and
 * without microseconds unless asked for. Values JavaScript cannot represent
 * (BC dates, infinity, years past 9999) are shown as they are.
 */

const TSTZ =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?(?::(\d{2}))?)$/i
const FRACTION = /(\d{2}:\d{2}:\d{2})\.\d+/

export interface TimeDisplay {
  /** timestamptz in the browser's zone, or as sent by the server */
  timeZone: 'local' | 'utc'
  fraction: boolean
}

interface Instant {
  /** milliseconds since the epoch (whole seconds; the fraction is kept as text) */
  ms: number
  /** ".919472" or "" */
  fraction: string
}

export function parseTimestamptz(text: string): Instant | null {
  const m = TSTZ.exec(text.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, frac, z, sign, oh, om, os] = m
  const offset = z ? 0 : (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om ?? 0) * 60 + Number(os ?? 0))
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offset * 1000
  if (Number.isNaN(ms)) return null
  return { ms, fraction: frac ?? '' }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** "+07", "+05:30", "-03": the browser's offset at that instant */
function localOffset(ms: number): string {
  const east = -new Date(ms).getTimezoneOffset()
  const sign = east < 0 ? '-' : '+'
  const abs = Math.abs(east)
  return `${sign}${pad(Math.floor(abs / 60))}${abs % 60 ? `:${pad(abs % 60)}` : ''}`
}

function localText(i: Instant, withFraction: boolean, withOffset: boolean): string {
  const t = new Date(i.ms)
  const date = `${pad(t.getFullYear(), 4)}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
  const time = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
  return `${date} ${time}${withFraction ? i.fraction : ''}${withOffset ? localOffset(i.ms) : ''}`
}

/** The same instant written in the browser's zone, offset included (for editing). */
export function toLocalTimestamptz(text: string): string | null {
  const i = parseTimestamptz(text)
  if (!i || new Date(i.ms).getFullYear() > 9999) return null
  return localText(i, true, true)
}

/** Whether two timestamptz texts name the same instant ("…+00" vs "…+07"). */
export function sameTimestamptz(a: string, b: string): boolean {
  if (a === b) return true
  const x = parseTimestamptz(a)
  const y = parseTimestamptz(b)
  const frac = (f: string) => f.replace(/0+$/, '').replace(/^\.$/, '')
  return Boolean(x && y && x.ms === y.ms && frac(x.fraction) === frac(y.fraction))
}

export function isZoned(typeName: string): boolean {
  return typeName === 'timestamptz' || typeName === 'timetz' || /with time zone/i.test(typeName)
}

/** Text to show in a cell for a date/time value. */
export function displayTemporal(text: string, typeName: string, display: TimeDisplay): string {
  if (display.timeZone === 'local' && (typeName === 'timestamptz' || /^timestamp.*with time zone/i.test(typeName))) {
    const i = parseTimestamptz(text)
    if (i && new Date(i.ms).getFullYear() <= 9999) return localText(i, display.fraction, false)
  }
  return display.fraction ? text : text.replace(FRACTION, '$1')
}

/** Short name of the browser's zone, e.g. "GMT+7". */
export function localZoneName(): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')
  return part?.value ?? 'local'
}
