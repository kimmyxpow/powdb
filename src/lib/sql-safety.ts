// Decides whether a SQL script can change data or structure, and whether it is destructive.
// Best effort on purpose: anything it does not understand counts as a change.
import { lineCommentEnd, splitStatements } from './sql'

interface SqlSafety {
  /** at least one statement may change data or structure (or could not be understood) */
  changes: boolean
  /** at least one statement drops, truncates, or deletes/updates every row */
  destructive: boolean
  /** the leading command of each statement, upper case (UNKNOWN when not understood) */
  commands: string[]
}

interface Token {
  kind: 'word' | 'open' | 'close'
  /** lower-case word, or the parenthesis */
  text: string
  /** parenthesis depth: words sit at the depth of their group; an open paren has the depth outside it */
  depth: number
  start: number
}

const UNKNOWN: SqlSafety = { changes: true, destructive: false, commands: ['UNKNOWN'] }

/** Commands that only read or manage the session. */
const READ_ONLY_COMMANDS = new Set([
  'show',
  'values',
  'table',
  'fetch',
  'begin',
  'start',
  'commit',
  'rollback',
  'set',
  'reset',
  'discard',
  'declare',
  'close',
  'listen',
])

/** Words that may sit between EXPLAIN and the explained statement. */
const EXPLAIN_OPTIONS = new Set([
  'analyze',
  'analyse',
  'verbose',
  'costs',
  'buffers',
  'timing',
  'summary',
  'settings',
  'wal',
  'serialize',
  'memory',
  'generic_plan',
  'format',
  'text',
  'json',
  'xml',
  'yaml',
  'on',
  'off',
  'true',
  'false',
])

/** Words that, right before UPDATE or DELETE, mean it is not a data change (ON CONFLICT DO UPDATE, FOR UPDATE, ON DELETE). */
const NOT_A_WRITE_BEFORE = new Set(['do', 'for', 'key', 'on'])

const MAX_NESTING = 4

/**
 * Tokens of one statement. Comments, strings, quoted identifiers and dollar-quoted bodies are skipped.
 * `ok` is false when a comment, string, identifier or dollar quote is never closed.
 */
function lex(sql: string): { tokens: Token[]; ok: boolean } {
  const tokens: Token[] = []
  const n = sql.length
  let depth = 0
  let ok = true
  let i = 0
  while (i < n) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      i = lineCommentEnd(sql, i)
      continue
    }
    if (ch === '/' && next === '*') {
      let level = 1
      i += 2
      while (i < n && level > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          level++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          level--
          i += 2
        } else i++
      }
      if (level > 0) ok = false
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === "'") {
      const escape = i > 0 && /[eE]/.test(sql[i - 1]!) && !/[\w$]/.test(sql[i - 2] ?? ' ')
      i++
      let closed = false
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
          closed = true
          break
        }
        i++
      }
      if (!closed) ok = false
      continue
    }
    if (ch === '"') {
      i++
      let closed = false
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        i++
      }
      if (!closed) ok = false
      continue
    }
    if (ch === '$' && !/[\w$]/.test(sql[i - 1] ?? ' ')) {
      const m = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 128))
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length)
        if (close === -1) ok = false
        i = close === -1 ? n : close + m[0].length
        continue
      }
    }
    if (ch === '(') {
      tokens.push({ kind: 'open', text: '(', depth, start: i })
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      tokens.push({ kind: 'close', text: ')', depth, start: i })
      i++
      continue
    }
    if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      let j = i + 1
      while (j < n && /[\w$\u0080-￿]/.test(sql[j]!)) j++
      tokens.push({ kind: 'word', text: sql.slice(i, j).toLowerCase(), depth, start: i })
      i = j
      continue
    }
    i++
  }
  return { tokens, ok }
}

const hasWord = (tokens: Token[], word: string) => tokens.some((t) => t.kind === 'word' && t.text === word)

/**
 * True when a DELETE or UPDATE in the statement has no WHERE in its own group
 * (so a top-level one touches every row). Best effort: a WHERE inside a subquery does not count.
 */
function writesWithoutWhere(tokens: Token[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind !== 'word' || (t.text !== 'delete' && t.text !== 'update')) continue
    const prev = tokens[i - 1]
    if (prev?.kind === 'word' && NOT_A_WRITE_BEFORE.has(prev.text)) continue
    let where = false
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j]!
      if (u.depth < t.depth) break
      if (u.kind === 'word' && u.depth === t.depth && u.text === 'where') {
        where = true
        break
      }
    }
    if (!where) return true
  }
  return false
}

function change(command: string, destructive: boolean): SqlSafety {
  return { changes: true, destructive, commands: [command] }
}

function readOnly(command: string): SqlSafety {
  return { changes: false, destructive: false, commands: [command] }
}

function classifyStatement(text: string, nesting: number): SqlSafety {
  if (nesting > MAX_NESTING) return UNKNOWN
  const { tokens, ok } = lex(text)
  if (!ok) return UNKNOWN

  // the first word, skipping opening parentheses: (SELECT 1) UNION (SELECT 2)
  let k = 0
  while (tokens[k]?.kind === 'open') k++
  const head = tokens[k]
  if (!head || head.kind !== 'word') return UNKNOWN

  const command = head.text
  const name = command.toUpperCase()

  if (command === 'with') {
    // a WITH is a change when any of its parts writes; the main command is not needed for that
    const writes = ['insert', 'update', 'delete', 'merge'].some((w) => hasWord(tokens, w))
    if (!writes && !hasWord(tokens, 'into')) return readOnly(name)
    return change(name, writesWithoutWhere(tokens))
  }

  switch (command) {
    case 'explain':
      return classifyExplain(text, tokens, k, nesting)
    case 'do':
      return change(name, /\b(drop|truncate)\b/i.test(text))
    case 'drop':
    case 'truncate':
      return change(name, true)
    case 'alter':
      // ALTER TABLE ... DROP COLUMN / CONSTRAINT; renames and additions are not destructive
      return change(name, hasWord(tokens, 'drop'))
    case 'insert':
      return change(name, false)
    case 'merge':
      return change(name, hasWord(tokens, 'delete'))
    case 'delete':
    case 'update':
      return change(name, writesWithoutWhere(tokens))
    case 'select':
      // SELECT ... INTO creates a table
      return hasWord(tokens, 'into') ? change(name, false) : readOnly(name)
    default:
      if (READ_ONLY_COMMANDS.has(command)) return readOnly(name)
      return change(name, false)
  }
}

/** EXPLAIN only runs the statement with ANALYZE; then the explained statement decides. */
function classifyExplain(text: string, tokens: Token[], k: number, nesting: number): SqlSafety {
  let idx = k + 1
  let analyze = false
  if (tokens[idx]?.kind === 'open') {
    const openDepth = tokens[idx]!.depth
    let j = idx + 1
    for (; j < tokens.length; j++) {
      const u = tokens[j]!
      if (u.kind === 'word' && (u.text === 'analyze' || u.text === 'analyse')) analyze = true
      if (u.kind === 'close' && u.depth === openDepth) break
    }
    idx = j + 1
  }
  while (tokens[idx]?.kind === 'word' && EXPLAIN_OPTIONS.has(tokens[idx]!.text)) {
    const word = tokens[idx]!.text
    if (word === 'analyze' || word === 'analyse') analyze = true
    idx++
  }
  if (!analyze) return readOnly('EXPLAIN')

  const start = tokens[idx]?.start
  const rest = start === undefined ? '' : text.slice(start)
  if (!rest.trim()) return UNKNOWN
  const inner = classifyStatement(rest, nesting + 1)
  return { changes: inner.changes, destructive: inner.destructive, commands: ['EXPLAIN', ...inner.commands] }
}

/**
 * Classifies a SQL script. Read-only: SELECT (without INTO), SHOW, EXPLAIN (without ANALYZE on a change),
 * VALUES, TABLE, FETCH, BEGIN, START, COMMIT, ROLLBACK, SET, RESET, DISCARD, DECLARE, CLOSE, LISTEN,
 * and WITH when it has no INSERT, UPDATE, DELETE or MERGE. Everything else is a change.
 */
export function classifySql(sql: string): SqlSafety {
  // an unclosed comment, string, identifier or dollar quote swallows the rest: never guess
  if (!lex(sql).ok) return { ...UNKNOWN, commands: [...UNKNOWN.commands] }
  const result: SqlSafety = { changes: false, destructive: false, commands: [] }
  for (const statement of splitStatements(sql)) {
    const s = classifyStatement(statement.text, 0)
    result.changes ||= s.changes
    result.destructive ||= s.destructive
    result.commands.push(...s.commands)
  }
  return result
}
