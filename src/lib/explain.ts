// Turns the JSON plan from EXPLAIN (FORMAT JSON) into a flat list of steps the Plan view can show.
// Pure code, no database access, so it can be tested without a server.

import { firstKeyword, qualifiedName, quoteIdent } from './sql'

export interface PlanNode {
  /** depth-first order, the root is 0 */
  id: number
  depth: number
  /** e.g. "Seq Scan on orders o", "Hash Join (inner)" */
  title: string
  /** short condition lines, e.g. "Filter: (status = 'paid')" */
  detail: string[]
  /** Plan Rows, times Actual Loops when analyzed, so it compares with actualRows */
  estRows: number
  /** Actual Rows * Actual Loops, null when the plan was not analyzed */
  actualRows: number | null
  /** Actual Loops, null when the plan was not analyzed */
  loops: number | null
  /** time spent in this step alone, null when the plan was not analyzed */
  selfMs: number | null
  /** cost of this step alone (Total Cost minus the children's Total Cost) */
  selfCost: number
  totalCost: number
  /** 0..1, this step's share of the total time (or cost when not analyzed) */
  share: number
  /** analyzed and never run, so the times are not real */
  neverExecuted: boolean
  /** plain English warnings about this step */
  warnings: PlanWarning[]
  /** the node without its "Plans" key, for the details view */
  raw: Record<string, unknown>
}

export type PlanWarningKind = 'full-scan' | 'estimate' | 'disk-sort' | 'hash-batches'

export interface PlanWarning {
  kind: PlanWarningKind
  text: string
}

export interface ParsedPlan {
  nodes: PlanNode[]
  analyzed: boolean
  planningMs: number | null
  executionMs: number | null
  totalCost: number
  /** the step with the largest share, when that share is at least 20% */
  slowestId: number | null
}

const BAD_PLAN = 'Could not read the plan'
/** A step must hold this much of the total to be marked as the slowest one. */
const SLOWEST_SHARE = 0.2

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Formats a count or cost for people: 1234567 -> "1.2M", 12345 -> "12.3K", 999 -> "999", 1.5 -> "1.5". */
export function formatPlanNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return `${sign}${Number(abs.toFixed(2))}`
}

/** A node as read from the JSON, with the numbers the report needs. */
interface Measured {
  node: Json
  depth: number
  children: Measured[]
  estRows: number
  totalCost: number
  /** Actual Total Time * Actual Loops, analyzed only */
  inclusiveMs: number | null
  /** Actual Rows * Actual Loops, analyzed only */
  actualRows: number | null
  /** Actual Loops, analyzed only */
  loops: number | null
  /** below a Limit, which stops reading once it has its rows, so fewer rows than planned is normal */
  belowLimit: boolean
}

function readNode(value: unknown, depth: number, analyzed: boolean, belowLimit = false): Measured {
  if (!isRecord(value)) throw new Error(BAD_PLAN)
  const nodeType = value['Node Type']
  const estRows = finiteNumber(value['Plan Rows'])
  const totalCost = finiteNumber(value['Total Cost'])
  if (typeof nodeType !== 'string' || estRows === null || totalCost === null) throw new Error(BAD_PLAN)

  const plans = value['Plans'] === undefined ? [] : value['Plans']
  if (!Array.isArray(plans)) throw new Error(BAD_PLAN)

  let inclusiveMs: number | null = null
  let actualRows: number | null = null
  let loops: number | null = null
  let rowsAll = estRows
  if (analyzed) {
    const time = finiteNumber(value['Actual Total Time'])
    const rows = finiteNumber(value['Actual Rows'])
    const count = finiteNumber(value['Actual Loops'])
    if (time === null || rows === null || count === null) throw new Error(BAD_PLAN)
    inclusiveMs = time * count
    actualRows = rows * count
    loops = count
    // Plan Rows is per loop, like Actual Rows; both are scaled so a step inside a loop compares fairly
    rowsAll = estRows * Math.max(count, 1)
  }

  return {
    node: value,
    depth,
    children: plans.map((child) => readNode(child, depth + 1, analyzed, belowLimit || nodeType === 'Limit')),
    estRows: rowsAll,
    totalCost,
    inclusiveMs,
    actualRows,
    loops,
    belowLimit,
  }
}

function titleFor(node: Json): string {
  // Postgres calls every write "ModifyTable" and names the kind in Operation (Insert, Update, ...)
  let title =
    node['Node Type'] === 'ModifyTable' && typeof node['Operation'] === 'string'
      ? node['Operation']
      : String(node['Node Type'])
  if (typeof node['Index Name'] === 'string') title += ` using ${node['Index Name']}`

  const relation = node['Relation Name']
  const alias = node['Alias']
  if (typeof relation === 'string') {
    title += ` on ${relation}`
    if (typeof alias === 'string' && alias !== relation) title += ` ${alias}`
  } else if (typeof node['CTE Name'] === 'string') {
    title += ` on ${node['CTE Name']}`
  } else if (typeof node['Function Name'] === 'string') {
    title += ` on ${node['Function Name']}`
  }

  if (typeof node['Join Type'] === 'string') title += ` (${node['Join Type'].toLowerCase()})`

  const strategy = node['Strategy']
  if (typeof strategy === 'string' && strategy !== 'Plain') title += ` (${strategy.toLowerCase()})`

  if (node['Parent Relationship'] === 'InitPlan' || node['Parent Relationship'] === 'SubPlan') {
    title = `Subquery: ${title}`
  }
  return title
}

/** Reads a list or a text value from the plan as one line. */
function textOf(value: unknown): string | null {
  if (Array.isArray(value)) return value.map((part) => String(part)).join(', ')
  if (typeof value === 'string') return value
  return null
}

const DETAIL_KEYS: [key: string, label: string][] = [
  ['Filter', 'Filter'],
  ['Index Cond', 'Index Cond'],
  ['Recheck Cond', 'Recheck Cond'],
  ['Hash Cond', 'Hash Cond'],
  ['Merge Cond', 'Merge Cond'],
  ['Join Filter', 'Join Filter'],
  ['Sort Key', 'Sort Key'],
  ['Group Key', 'Group Key'],
]

function detailFor(node: Json): string[] {
  const lines: string[] = []
  for (const [key, label] of DETAIL_KEYS) {
    const text = textOf(node[key])
    if (text !== null) lines.push(`${label}: ${text}`)
  }
  return lines
}

function warningsFor(m: Measured): PlanWarning[] {
  const { node, estRows, actualRows, loops } = m
  const warnings: PlanWarning[] = []
  // a step that never ran has no real numbers to warn about
  if (loops === 0) return warnings

  // Rows Removed by Filter is an average per loop, like Actual Rows
  const perLoop = finiteNumber(node['Rows Removed by Filter'])
  const removed = perLoop === null ? null : perLoop * Math.max(loops ?? 1, 1)
  if (actualRows !== null && node['Node Type'] === 'Seq Scan' && removed !== null) {
    if (removed >= 10_000 && removed > 10 * actualRows) {
      warnings.push({
        kind: 'full-scan',
        text: `Read the whole table and threw away ${formatPlanNumber(removed)} rows. An index on the filtered columns may help.`,
      })
    }
  }

  // below a Limit the step stops early on purpose, so only finding more rows than planned counts
  if (actualRows !== null && !(m.belowLimit && actualRows < estRows)) {
    const high = Math.max(estRows, actualRows)
    const low = Math.min(estRows, actualRows)
    if (high >= 100 && high / Math.max(low, 1) >= 10) {
      warnings.push({
        kind: 'estimate',
        text: `Postgres expected ${formatPlanNumber(estRows)} ${estRows === 1 ? 'row' : 'rows'} but got ${formatPlanNumber(actualRows)}. Running ANALYZE on the table updates its statistics.`,
      })
    }
  }

  const sortUsed = finiteNumber(node['Sort Space Used'])
  if (node['Sort Space Type'] === 'Disk' && sortUsed !== null) {
    warnings.push({
      kind: 'disk-sort',
      text: `The sort did not fit in memory and used ${formatPlanNumber(sortUsed)} kB of disk. A higher work_mem may help.`,
    })
  }

  const batches = finiteNumber(node['Hash Batches'])
  if (batches !== null && batches > 1) {
    warnings.push({
      kind: 'hash-batches',
      text: `The hash table did not fit in memory and was split into ${formatPlanNumber(batches)} batches.`,
    })
  }

  return warnings
}

/**
 * Reads the plan that EXPLAIN (FORMAT JSON) returned, one object with "Plan" and optional timings.
 * Throws Error('Could not read the plan') when the shape is not what Postgres writes.
 */
export function parsePlan(raw: unknown, analyzed: boolean): ParsedPlan {
  if (!isRecord(raw) || !isRecord(raw['Plan'])) throw new Error(BAD_PLAN)
  const root = readNode(raw['Plan'], 0, analyzed)

  const nodes: PlanNode[] = []
  const visit = (m: Measured): void => {
    const childMs = m.children.reduce((sum, child) => sum + (child.inclusiveMs ?? 0), 0)
    const childCost = m.children.reduce((sum, child) => sum + child.totalCost, 0)
    const selfMs = m.inclusiveMs === null ? null : Math.max(0, m.inclusiveMs - childMs)
    const selfCost = Math.max(0, m.totalCost - childCost)
    const id = nodes.length
    nodes.push({
      id,
      depth: m.depth,
      title: titleFor(m.node),
      detail: detailFor(m.node),
      estRows: m.estRows,
      actualRows: m.actualRows,
      loops: m.loops,
      selfMs,
      selfCost,
      totalCost: m.totalCost,
      share: 0,
      neverExecuted: analyzed && m.loops === 0,
      warnings: warningsFor(m),
      raw: Object.fromEntries(Object.entries(m.node).filter(([key]) => key !== 'Plans')),
    })
    m.children.forEach(visit)
  }
  visit(root)

  const total = nodes.reduce((sum, node) => sum + (analyzed ? (node.selfMs ?? 0) : node.selfCost), 0)
  for (const node of nodes) {
    const part = analyzed ? (node.selfMs ?? 0) : node.selfCost
    node.share = total > 0 ? part / total : 0
  }

  let slowest: PlanNode | null = null
  for (const node of nodes) {
    if (slowest === null || node.share > slowest.share) slowest = node
  }
  // when the whole query takes under a millisecond, no step is worth pointing at
  const worthIt = !analyzed || total >= 1
  const slowestId = worthIt && slowest !== null && slowest.share >= SLOWEST_SHARE ? slowest.id : null

  return {
    nodes,
    analyzed,
    planningMs: finiteNumber(raw['Planning Time']),
    executionMs: finiteNumber(raw['Execution Time']),
    totalCost: root.totalCost,
    slowestId,
  }
}

/** Statements that EXPLAIN can take. DDL, SET, SHOW and the like get no Explain button. */
const EXPLAINABLE = new Set(['select', 'with', 'insert', 'update', 'delete', 'merge', 'values', 'table'])

/** True when the statement starts with a word EXPLAIN can take (leading comments and parens are skipped). */
export function isExplainable(sql: string): boolean {
  const keyword = firstKeyword(sql)
  return keyword !== null && EXPLAINABLE.has(keyword)
}

/** A table as the completion schema lists it. */
export interface KnownTable {
  schema: string
  name: string
  columns: string[]
}

/** An equality comparison (after <>, !=, <= and >= are taken out), also = ANY (...) and IS NULL. */
const EQUALITY = /=|\bIS\s+NULL\b/i
/** At most this many columns go into a suggested index. */
const MAX_INDEX_COLUMNS = 3
/** Words followed by `(` that are not function calls. */
const NOT_FUNCTIONS = new Set(['any', 'all', 'array', 'row', 'and', 'not', 'in'])

/** Replaces every string literal with '' so its text is never read as SQL. A doubled quote inside is an escape. */
function stripStringLiterals(sql: string): string {
  return sql.replace(/(?<![A-Za-z0-9_])[Ee]?'(?:[^']|'')*'/g, "''")
}

/** Finds the table a plan step reads. A name in several schemas only counts when one of them is public. */
function findTable(name: string, tables: readonly KnownTable[]): KnownTable | null {
  const matches = tables.filter((t) => t.name === name)
  if (matches.length <= 1) return matches[0] ?? null
  return matches.find((t) => t.schema === 'public') ?? null
}

/** A cast type after `::`. Several words are allowed, such as `character varying`, but the type stops before AND. */
const TYPE_NAME = /"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*(?: +(?!and\b)[A-Za-z_][A-Za-z0-9_]*)*/iy
const NUMBER = /[0-9][A-Za-z0-9_.]*/y
const QUOTED_IDENT = /"((?:[^"]|"")*)"/y
const BARE_IDENT = /[A-Za-z_][A-Za-z0-9_$]*/y
const CALL = /[ ]*\(/y

/**
 * The column names in a filter, in order of first appearance (duplicates included).
 * Returns null when the filter calls a function, since a plain index on the column cannot serve it.
 */
function filterColumns(sql: string): string[] | null {
  const names: string[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (sql.startsWith('::', i)) {
      TYPE_NAME.lastIndex = i + 2
      const type = TYPE_NAME.exec(sql)
      i += type ? 2 + type[0].length : 2
      continue
    }
    if (ch >= '0' && ch <= '9') {
      // a number such as 1.5 or 1e5 is never a column
      NUMBER.lastIndex = i
      i += NUMBER.exec(sql)![0].length
      continue
    }
    let name: string
    if (ch === '"') {
      QUOTED_IDENT.lastIndex = i
      const match = QUOTED_IDENT.exec(sql)
      if (!match) return null
      name = match[1]!.replace(/""/g, '"')
      i += match[0].length
    } else if (/[A-Za-z_]/.test(ch)) {
      BARE_IDENT.lastIndex = i
      name = BARE_IDENT.exec(sql)![0]
      i += name.length
    } else {
      i++
      continue
    }
    // a qualifier before a dot (o.status) is a table or alias, not a column
    if (sql[i] === '.') continue
    CALL.lastIndex = i
    if (CALL.test(sql) && !NOT_FUNCTIONS.has(name.toLowerCase())) return null
    names.push(name)
  }
  return names
}

/**
 * Suggests a CREATE INDEX for a plan step that read a whole table to keep a few rows, or null when no
 * simple index would clearly help. Only plain columns in a simple filter are used.
 */
export function suggestIndex(node: PlanNode, tables: readonly KnownTable[]): string | null {
  if (!node.warnings.some((w) => w.kind === 'full-scan')) return null

  const relation = node.raw['Relation Name']
  const filter = node.raw['Filter']
  if (typeof relation !== 'string' || typeof filter !== 'string') return null
  const table = findTable(relation, tables)
  if (!table) return null

  const sql = stripStringLiterals(filter)
  // OR needs more than one index, so one index on these columns cannot serve it
  if (/\bOR\b/i.test(sql)) return null
  // an index can only search a comparison; <> and != cannot use one
  const compared = sql.replace(/<>|!=/g, '')
  if (!/[=<>]|~~|\bIS\s+NULL\b/i.test(compared)) return null

  // A B-tree index works best with the columns compared by equality first and range columns after,
  // so each AND part is sorted into one of the two groups.
  const equal: string[] = []
  const other: string[] = []
  for (const part of sql.split(/\bAND\b/i)) {
    const columns = filterColumns(part)
    if (columns === null) return null
    const isEqual = EQUALITY.test(part.replace(/<>|!=|<=|>=/g, ''))
    for (const name of columns) (isEqual ? equal : other).push(name)
  }
  const known: string[] = []
  for (const name of [...equal, ...other]) {
    if (known.length === MAX_INDEX_COLUMNS) break
    if (known.includes(name) || !table.columns.includes(name)) continue
    known.push(name)
  }
  if (known.length === 0) return null

  const list = known.map((name) => quoteIdent(name)).join(', ')
  return `CREATE INDEX CONCURRENTLY ON ${qualifiedName(table.schema, table.name)} (${list});`
}
