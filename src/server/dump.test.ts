import { afterEach, describe, expect, test } from 'bun:test'
import type { SslMode } from '@/lib/types'
import { databaseExportUrl } from '@/lib/db-export'
import {
  buildDumpPlan,
  exportFilename,
  locatePgDump,
  parseExportParams,
  quotePgName,
  type DumpTarget,
} from './dump.server'

const PG = '/usr/lib/postgresql/18/bin/pg_dump'
const SECRET = 'p@ss w\'o"rd\\1'

function target(overrides: Partial<DumpTarget> = {}): DumpTarget {
  return {
    host: '127.0.0.1',
    port: 55432,
    user: 'demo',
    database: 'shop',
    ssl: 'disable',
    password: SECRET,
    ...overrides,
  }
}

function plan(req: Partial<Parameters<typeof buildDumpPlan>[2]> = {}, t: Partial<DumpTarget> = {}) {
  return buildDumpPlan(PG, target(t), { content: 'all', format: 'sql', ...req })
}

const ORIGINAL_PG_DUMP = process.env.POWVIEW_PG_DUMP
afterEach(() => {
  if (ORIGINAL_PG_DUMP === undefined) delete process.env.POWVIEW_PG_DUMP
  else process.env.POWVIEW_PG_DUMP = ORIGINAL_PG_DUMP
})

describe('quotePgName', () => {
  test('wraps the name in double quotes so case, dots and wildcards stay literal', () => {
    expect(quotePgName('Mixed Case Table')).toBe('"Mixed Case Table"')
    expect(quotePgName('with.dot')).toBe('"with.dot"')
    expect(quotePgName('star*and?')).toBe('"star*and?"')
  })

  test('doubles embedded double quotes', () => {
    expect(quotePgName('say "hi"')).toBe('"say ""hi"""')
  })
})

describe('buildDumpPlan: content and format', () => {
  test('a full plain dump uses no content filter and no verbose flag', () => {
    const { args } = plan()
    expect(args[0]).toBe(PG)
    expect(args).toContain('--format=plain')
    expect(args).toContain('--no-owner')
    expect(args).toContain('--no-privileges')
    expect(args).toContain('--no-password')
    expect(args).not.toContain('--schema-only')
    expect(args).not.toContain('--data-only')
    expect(args.some((a) => a === '--verbose' || a === '-v')).toBe(false)
  })

  test('structure only adds --schema-only', () => {
    const { args } = plan({ content: 'schema' })
    expect(args).toContain('--schema-only')
    expect(args).not.toContain('--data-only')
  })

  test('data only adds --data-only', () => {
    const { args } = plan({ content: 'data' })
    expect(args).toContain('--data-only')
    expect(args).not.toContain('--schema-only')
  })

  test('custom format', () => {
    expect(plan({ format: 'custom' }).args).toContain('--format=custom')
    expect(plan({ format: 'sql' }).args).toContain('--format=plain')
  })

  test('sql-gz is plain output compressed by pg_dump', () => {
    const { args } = plan({ format: 'sql-gz' })
    expect(args).toContain('--format=plain')
    expect(args).toContain('--compress=6')
  })

  test('sql and custom never ask for --compress', () => {
    for (const format of ['sql', 'custom'] as const) {
      expect(plan({ format }).args.some((a) => a.startsWith('--compress'))).toBe(false)
    }
  })
})

describe('buildDumpPlan: schemas and tables', () => {
  test('one --schema per schema, quoted', () => {
    const { args } = plan({ schemas: ['app', 'Billing Area'] })
    expect(args).toContain('--schema="app"')
    expect(args).toContain('--schema="Billing Area"')
    expect(args.filter((a) => a.startsWith('--schema='))).toHaveLength(2)
  })

  test('tables with odd names are quoted per part, so dots and spaces survive', () => {
    const { args } = plan({
      tables: [
        { schema: 'public', name: 'Mixed Case Table' },
        { schema: 'public', name: 'with.dot' },
        { schema: 'my.schema', name: 'orders' },
      ],
    })
    expect(args).toContain('--table="public"."Mixed Case Table"')
    expect(args).toContain('--table="public"."with.dot"')
    expect(args).toContain('--table="my.schema"."orders"')
  })

  test('a table name with a double quote is escaped', () => {
    const { args } = plan({ tables: [{ schema: 'public', name: 'a"b' }] })
    expect(args).toContain('--table="public"."a""b"')
  })

  test('schemas and tables together are refused (pg_dump would AND them)', () => {
    expect(() => plan({ schemas: ['app'], tables: [{ schema: 'public', name: 'orders' }] })).toThrow(
      'Choose schemas or tables, not both.',
    )
  })
})

describe('buildDumpPlan: connection and ssl', () => {
  test('--dbname carries host, port, user and database as one libpq string', () => {
    const { args } = plan()
    const dbname = args.find((a) => a.startsWith('--dbname='))!
    expect(dbname).toBe("--dbname=host='127.0.0.1' port='55432' user='demo' dbname='shop'")
  })

  test('quotes and backslashes in the database name are escaped for libpq', () => {
    const { args } = plan({}, { database: "it's\\odd" })
    expect(args.find((a) => a.startsWith('--dbname='))).toContain("dbname='it\\'s\\\\odd'")
  })

  test.each<[SslMode, string]>([
    ['disable', 'disable'],
    ['require', 'require'],
    ['verify-full', 'verify-full'],
  ])('ssl %s becomes PGSSLMODE=%s', (mode, expected) => {
    expect(plan({}, { ssl: mode }).env.PGSSLMODE).toBe(expected)
  })
})

describe('buildDumpPlan: the password', () => {
  test('never appears in the argument list', () => {
    const { args } = plan()
    for (const arg of args) expect(arg).not.toContain(SECRET)
    expect(args.join(' ')).not.toContain('w\'o"rd')
  })

  test('travels only in PGPASSWORD', () => {
    const { env } = plan()
    expect(env.PGPASSWORD).toBe(SECRET)
  })

  test('no PGPASSWORD when the connection has no password', () => {
    const { env } = plan({}, { password: undefined })
    expect(env.PGPASSWORD).toBeUndefined()
  })

  test('the environment does not inherit PG* variables from the server', () => {
    const { env } = plan()
    for (const key of Object.keys(env)) {
      if (key.startsWith('PG')) expect(['PGPASSWORD', 'PGSSLMODE', 'PGCONNECT_TIMEOUT', 'PGAPPNAME']).toContain(key)
    }
  })
})

describe('parseExportParams', () => {
  const q = (s: string) => new URLSearchParams(s)

  test('defaults to everything as SQL', () => {
    expect(parseExportParams(q('connection=c1&database=shop'))).toEqual({
      connection: 'c1',
      database: 'shop',
      content: 'all',
      format: 'sql',
      schemas: [],
      tables: [],
    })
  })

  test('accepts format=sql-gz', () => {
    expect(parseExportParams(q('connection=c1&database=shop&format=sql-gz')).format).toBe('sql-gz')
  })

  test('reads comma lists, trims and drops repeats', () => {
    const req = parseExportParams(q('connection=c1&database=shop&schemas=app, billing,app'))
    expect(req.schemas).toEqual(['app', 'billing'])
  })

  test('splits table names at the first dot only', () => {
    const req = parseExportParams(q('connection=c1&database=shop&tables=public.with.dot,my.schema.orders'))
    expect(req.tables).toEqual([
      { schema: 'public', name: 'with.dot' },
      { schema: 'my', name: 'schema.orders' },
    ])
  })

  test('rejects bad values with a 400', () => {
    const bad = [
      'database=shop',
      'connection=c1',
      'connection=c1&database=shop&content=everything',
      'connection=c1&database=shop&format=zip',
      'connection=c1&database=shop&tables=orders',
      'connection=c1&database=shop&tables=.orders',
      'connection=c1&database=shop&schemas=app&tables=public.orders',
    ]
    for (const s of bad) {
      expect(() => parseExportParams(q(s))).toThrow()
    }
  })

  test('round trips through databaseExportUrl', () => {
    const url = databaseExportUrl({
      connection: 'c1',
      database: 'shop',
      content: 'data',
      format: 'custom',
      tables: [
        { schema: 'public', name: 'Mixed Case Table' },
        { schema: 'public', name: 'with.dot' },
      ],
    })
    const req = parseExportParams(new URL(url, 'http://x').searchParams)
    expect(req.content).toBe('data')
    expect(req.format).toBe('custom')
    expect(req.tables).toEqual([
      { schema: 'public', name: 'Mixed Case Table' },
      { schema: 'public', name: 'with.dot' },
    ])
  })
})

describe('exportFilename', () => {
  test('database name, local date and time, and the extension for the format', () => {
    const at = new Date(2026, 10, 7, 9, 5)
    expect(exportFilename('shop', 'sql', at)).toBe('shop-20261107-0905.sql')
    expect(exportFilename('shop', 'custom', at)).toBe('shop-20261107-0905.dump')
  })

  test('sql-gz names the file .sql.gz', () => {
    const at = new Date(2026, 10, 17, 11, 38)
    expect(exportFilename('shop', 'sql-gz', at)).toBe('shop-20261117-1138.sql.gz')
    expect(exportFilename('shop', 'sql', at)).toBe('shop-20261117-1138.sql')
    expect(exportFilename('shop', 'custom', at)).toBe('shop-20261117-1138.dump')
  })

  test('replaces characters that do not belong in a file name', () => {
    const at = new Date(2026, 0, 2, 3, 4)
    expect(exportFilename('My Shop/2025"', 'sql', at)).toBe('My_Shop_2025-20260102-0304.sql')
    expect(exportFilename('///', 'sql', at)).toBe('database-20260102-0304.sql')
  })
})

describe('locatePgDump', () => {
  test('POWVIEW_PG_DUMP pointing at a missing file means pg_dump is missing', () => {
    process.env.POWVIEW_PG_DUMP = '/nonexistent/powview/pg_dump'
    expect(locatePgDump()).toBeNull()
  })
})

describe('buildDumpPlan through an SSH tunnel', () => {
  test('libpq connects to the local tunnel end (hostaddr) and checks the certificate against the real host', () => {
    const { args } = plan({}, { host: '127.0.0.1', port: 55555, tlsHost: 'db.internal', ssl: 'verify-full' })
    const dbname = args.find((a) => a.startsWith('--dbname='))!
    expect(
      dbname.startsWith("--dbname=host='db.internal' hostaddr='127.0.0.1' port='55555' user='demo' dbname='shop'"),
    ).toBe(true)
    expect(args.join(' ')).not.toContain(SECRET)
  })

  test('without a tunnel the conninfo keeps the plain host and no hostaddr', () => {
    const { args } = plan()
    const dbname = args.find((a) => a.startsWith('--dbname='))!
    expect(dbname).not.toContain('hostaddr')
    expect(dbname.startsWith("--dbname=host='127.0.0.1' port='55432'")).toBe(true)
  })

  test('the TLS mode is passed on as PGSSLMODE', () => {
    const { env } = plan({}, { host: '127.0.0.1', tlsHost: 'db.internal', ssl: 'verify-full' })
    expect(env.PGSSLMODE).toBe('verify-full')
  })
})
