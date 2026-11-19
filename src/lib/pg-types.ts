import type { ValueKind } from './types'

// Well-known built-in type OIDs → [short name, kind]
const BUILTIN: Record<number, [string, ValueKind]> = {
  16: ['bool', 'boolean'],
  17: ['bytea', 'binary'],
  18: ['char', 'text'],
  19: ['name', 'text'],
  20: ['int8', 'number'],
  21: ['int2', 'number'],
  23: ['int4', 'number'],
  24: ['regproc', 'text'],
  25: ['text', 'text'],
  26: ['oid', 'number'],
  27: ['tid', 'text'],
  28: ['xid', 'number'],
  114: ['json', 'json'],
  142: ['xml', 'text'],
  194: ['pg_node_tree', 'text'],
  600: ['point', 'other'],
  650: ['cidr', 'network'],
  700: ['float4', 'number'],
  701: ['float8', 'number'],
  705: ['unknown', 'text'],
  774: ['macaddr8', 'network'],
  790: ['money', 'number'],
  829: ['macaddr', 'network'],
  869: ['inet', 'network'],
  1033: ['aclitem', 'text'],
  1042: ['bpchar', 'text'],
  1043: ['varchar', 'text'],
  1082: ['date', 'date'],
  1083: ['time', 'time'],
  1114: ['timestamp', 'timestamp'],
  1184: ['timestamptz', 'timestamp'],
  1186: ['interval', 'interval'],
  1266: ['timetz', 'time'],
  1560: ['bit', 'text'],
  1562: ['varbit', 'text'],
  1700: ['numeric', 'number'],
  2205: ['regclass', 'text'],
  2206: ['regtype', 'text'],
  2950: ['uuid', 'uuid'],
  3220: ['pg_lsn', 'text'],
  3614: ['tsvector', 'text'],
  3615: ['tsquery', 'text'],
  3802: ['jsonb', 'json'],
  4089: ['regnamespace', 'text'],
  4096: ['regrole', 'text'],
}

/** Kind from a pg_type row (typname + typcategory + typtype). */
export function kindFromPgType(typname: string, category: string, typtype: string): ValueKind {
  if (typtype === 'e') return 'enum'
  switch (category) {
    case 'A':
      return 'array'
    case 'B':
      return 'boolean'
    case 'N':
      return typname.startsWith('reg') ? 'text' : 'number'
    case 'S':
      return 'text'
    case 'I':
      return 'network'
    case 'E':
      return 'enum'
    case 'T':
      return 'interval'
    case 'D':
      if (typname === 'date') return 'date'
      if (typname === 'time' || typname === 'timetz') return 'time'
      return 'timestamp'
  }
  if (typname === 'json' || typname === 'jsonb') return 'json'
  if (typname === 'uuid') return 'uuid'
  if (typname === 'bytea') return 'binary'
  return 'other'
}

export function builtinType(oid: number): { name: string; kind: ValueKind } | null {
  const t = BUILTIN[oid]
  return t ? { name: t[0], kind: t[1] } : null
}
