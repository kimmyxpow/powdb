// SQL helpers shared by the server and the client.

/** Index where the `--` comment starting at `start` ends: the first `\r` or `\n`, as PostgreSQL's scanner does. */
export function lineCommentEnd(sql: string, start: number): number {
  let i = start
  while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
  return i
}

/** Always-quoted identifier, safe to embed in SQL. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Quoted "schema"."name" */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

const RESERVED = new Set(
  `all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table tablesample then to trailing true union unique user using variadic verbose when where window with`.split(
    ' ',
  ),
)

/** Identifier for display/generated SQL: only quoted when needed. */
export function displayIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name
  return quoteIdent(name)
}

export function displayQualified(schema: string, name: string): string {
  return schema === 'public' ? displayIdent(name) : `${displayIdent(schema)}.${displayIdent(name)}`
}

/** SQL string literal (for previews / generated scripts, never for execution of user input). */
export function quoteLiteral(value: string): string {
  if (value.includes('\\')) {
    return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  }
  return `'${value.replace(/'/g, "''")}'`
}

export interface StatementRange {
  /** statement text (without the trailing semicolon) */
  text: string
  from: number
  to: number
}

/**
 * Split a script into statements. Understands single/double quotes,
 * E'' strings, dollar quoting, line comments and nested block comments.
 * Comment-only statements are dropped.
 */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = []
  let i = 0
  let hasCode = false
  let codeStart = -1
  const n = sql.length

  const push = (end: number) => {
    if (hasCode && codeStart >= 0) {
      let to = end
      while (to > codeStart && /\s/.test(sql[to - 1]!)) to--
      out.push({ text: sql.slice(codeStart, to), from: codeStart, to })
    }
    hasCode = false
    codeStart = -1
  }

  const markCode = (pos: number) => {
    if (!hasCode) {
      hasCode = true
      codeStart = pos
    }
  }

  while (i < n) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      i = lineCommentEnd(sql, i)
      continue
    }
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    if (ch === ';') {
      push(i)
      i++
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }

    markCode(i)

    // string literal (incl. E'..' escapes)
    if (ch === "'") {
      const escape = i > 0 && /[eE]/.test(sql[i - 1]!) && !/[\w$]/.test(sql[i - 2] ?? ' ')
      i++
      while (i < n) {
        if (escape && sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '$' && !/[\w$]/.test(sql[i - 1] ?? ' ')) {
      const m = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        continue
      }
    }
    i++
  }
  push(n)
  return out
}

/** The statement under the cursor (or the closest one before it). */
export function statementAt(sql: string, cursor: number): StatementRange | null {
  const statements = splitStatements(sql)
  if (statements.length === 0) return null
  let best: StatementRange | null = null
  for (const s of statements) {
    // a statement "owns" the text up to and including its semicolon
    const semicolon = sql.indexOf(';', s.to)
    const end = semicolon === -1 ? sql.length : semicolon + 1
    if (cursor >= s.from && cursor <= end) return s
    if (s.from <= cursor) best = s
  }
  return best ?? statements[0]!
}

/**
 * The first word of a statement, in lower case, skipping whitespace, comments and opening
 * parens. Null when there is no word.
 */
export function firstKeyword(sql: string): string | null {
  let s = sql
  for (;;) {
    const before = s
    s = s
      .replace(/^\s+/, '')
      .replace(/^--[^\r\n]*/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '')
      .replace(/^\(/, '')
    if (s === before) break
  }
  const m = /^([A-Za-z]+)/.exec(s)
  return m ? m[1]!.toLowerCase() : null
}
