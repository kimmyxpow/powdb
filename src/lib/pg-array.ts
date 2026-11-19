/**
 * Parse a one-dimensional PostgreSQL array literal ("{a,"b c",NULL}") for display.
 * Returns null for anything it does not fully understand (nested arrays, odd delimiters),
 * so callers can fall back to the raw text.
 */
export function parsePgArray(text: string): (string | null)[] | null {
  if (text.length < 2 || text[0] !== '{' || text[text.length - 1] !== '}') return null
  const inner = text.slice(1, -1)
  if (inner === '') return []
  const out: (string | null)[] = []
  let i = 0
  while (i <= inner.length) {
    if (inner[i] === '{') return null
    if (inner[i] === '"') {
      let item = ''
      i++
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === '\\') i++
        item += inner[i] ?? ''
        i++
      }
      if (inner[i] !== '"') return null
      i++
      out.push(item)
    } else {
      let item = ''
      while (i < inner.length && inner[i] !== ',') {
        item += inner[i]
        i++
      }
      out.push(item === 'NULL' ? null : item)
    }
    if (i >= inner.length) break
    if (inner[i] !== ',') return null
    i++
  }
  return out
}

/** Build a one-dimensional array literal; every non-NULL item is quoted, which PostgreSQL accepts for any element type. */
export function toPgArray(items: readonly (string | null)[]): string {
  return `{${items.map((v) => (v === null ? 'NULL' : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`
}
