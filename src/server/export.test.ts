import { describe, expect, test } from 'bun:test'
import { buildViewQuery, usesCtid, type RelationShape } from './data.server'
import { encoders, exportFileName, parseTableExportRequest, rowObject, type ExportTarget } from './export.server'
import { HttpError } from './http/util.server'
import type { Cell, ValueKind } from '@/lib/types'

const field = (name: string, kind: ValueKind) => ({ name, kind })

const target = (fields: { name: string; kind: ValueKind }[], table = '"public"."t"'): ExportTarget => ({
  table,
  fields,
})

/** The whole body, as the stream would send it: head, batches with offsets, foot. */
function body(format: keyof typeof encoders, t: ExportTarget, batches: Cell[][][]): string {
  const enc = encoders[format]
  let offset = 0
  let out = enc.head(t)
  for (const batch of batches) {
    out += enc.rows(t, batch, offset)
    offset += batch.length
  }
  return out + enc.foot(offset)
}

describe('CSV encoder', () => {
  const fields = [field('id', 'number'), field('label', 'text'), field('note', 'text'), field('ok', 'boolean')]

  test('header row, RFC 4180 quoting, NULL as an empty field, booleans as true/false', () => {
    const rows: Cell[][] = [
      ['1', 'plain', null, true],
      ['2', 'a,b', 'say "hi"', false],
    ]
    expect(body('csv', target(fields), [rows])).toBe(
      'id,label,note,ok\r\n' + '1,plain,,true\r\n' + '2,"a,b","say ""hi""",false\r\n',
    )
  })

  test('newlines and carriage returns inside values are quoted; unicode passes through', () => {
    const rows: Cell[][] = [['3', 'line one\nline two', 'cr\rhere', 'ünï 😀 中文']]
    expect(body('csv', target(fields), [rows])).toBe(
      'id,label,note,ok\r\n' + '3,"line one\nline two","cr\rhere",ünï 😀 中文\r\n',
    )
  })

  test('empty string is not NULL and is written as an empty quoted-free field', () => {
    expect(encoders.csv.rows(target(fields), [['4', '', null, null]], 0)).toBe('4,,,\r\n')
  })

  test('column names are escaped in the header', () => {
    const t = target([field('weird,name', 'text'), field('say "x"', 'text')])
    expect(encoders.csv.head(t)).toBe('"weird,name","say ""x"""\r\n')
  })

  test('a table with no rows is just the header', () => {
    expect(body('csv', target(fields), [])).toBe('id,label,note,ok\r\n')
  })

  test('batches concatenate without a separator', () => {
    const a: Cell[][] = [['1', 'x', null, true]]
    const b: Cell[][] = [['2', 'y', null, false]]
    expect(body('csv', target(fields), [a, b])).toBe('id,label,note,ok\r\n1,x,,true\r\n2,y,,false\r\n')
  })
})

describe('JSON encoders', () => {
  const fields = [
    field('id', 'number'),
    field('big', 'number'),
    field('ok', 'boolean'),
    field('data', 'json'),
    field('broken', 'json'),
    field('name', 'text'),
    field('note', 'text'),
    field('__proto__', 'text'),
  ]
  const row = (i: number): Cell[] => [
    String(i),
    '9007199254740993',
    i % 2 === 0,
    '{"a":[1,2]}',
    '{not json',
    'ünï 😀 "q"\nline',
    null,
    `proto-${i}`,
  ]

  test('a JSON array of objects, valid even across batches (offsets set the commas)', () => {
    const text = body('json', target(fields), [[row(1), row(2)], [row(3)]])
    const parsed = JSON.parse(text) as Record<string, unknown>[]
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toMatchObject({
      id: 1,
      big: '9007199254740993',
      ok: false,
      data: { a: [1, 2] },
      broken: '{not json',
      name: 'ünï 😀 "q"\nline',
      note: null,
    })
    expect(parsed[1]!.ok).toBe(true)
    expect(parsed[2]!.id).toBe(3)
  })

  test('a column named __proto__ is an ordinary key', () => {
    const text = body('json', target(fields), [[row(1)]])
    const parsed = JSON.parse(text) as Record<string, unknown>[]
    expect(Object.keys(parsed[0]!)).toContain('__proto__')
    expect(parsed[0]!['__proto__']).toBe('proto-1')
  })

  test('an empty table is an empty array', () => {
    expect(JSON.parse(body('json', target(fields), []))).toEqual([])
  })

  test('NDJSON: one object per line, newlines inside values stay escaped', () => {
    const text = body('ndjson', target(fields), [[row(1), row(2)], [row(3)]])
    const lines = text.split('\n')
    expect(lines.at(-1)).toBe('')
    const objects = lines.slice(0, -1).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(objects.map((o) => o.id)).toEqual([1, 2, 3])
    expect(objects[0]!.name).toBe('ünï 😀 "q"\nline')
  })

  test('NDJSON with no rows is empty', () => {
    expect(body('ndjson', target(fields), [])).toBe('')
  })

  test('rowObject keeps the output names unique and the values typed', () => {
    const obj = rowObject(['a', 'a_2'], [field('a', 'number'), field('a', 'text')], ['7', 'x'])
    expect({ ...obj }).toEqual({ a: 7, a_2: 'x' })
  })
})

describe('SQL INSERT encoder', () => {
  const fields = [
    field('id', 'number'),
    field('name', 'text'),
    field('path', 'text'),
    field('memo', 'text'),
    field('ok', 'boolean'),
    field('amount', 'number'),
    field('data', 'json'),
    field('Mixed Case', 'text'),
  ]

  test('literals are escaped and typed: quotes doubled, backslashes in E-strings, NULL, booleans, bare numbers', () => {
    const t = target(fields, '"analytics"."t"')
    const rows: Cell[][] = [
      ['1', "O'Brien", 'C:\\new', null, true, '1.5e3', '{"a": 1}', 'x'],
      ['2', 'multi\nline & whitespace\ttab', '', 'unicode & emoji 😀 ünï', false, '-12.75', '[1,"two"]', 'y'],
    ]
    expect(encoders.sql.rows(t, rows, 0)).toBe(
      `INSERT INTO "analytics"."t" (id, name, path, memo, ok, amount, data, "Mixed Case") VALUES (1, 'O''Brien', E'C:\\\\new', NULL, TRUE, 1.5e3, '{"a": 1}', 'x');\n` +
        `INSERT INTO "analytics"."t" (id, name, path, memo, ok, amount, data, "Mixed Case") VALUES (2, 'multi\nline & whitespace\ttab', '', 'unicode & emoji 😀 ünï', FALSE, -12.75, '[1,"two"]', 'y');\n`,
    )
  })

  test('a text value that looks like a number stays quoted only when its kind is text', () => {
    const t = target([field('code', 'text'), field('n', 'number')], '"public"."c"')
    expect(encoders.sql.rows(t, [['007', '007']], 0)).toBe(`INSERT INTO "public"."c" (code, n) VALUES ('007', 007);\n`)
  })

  test('a table with no rows writes a comment', () => {
    expect(body('sql', target(fields), [])).toBe('-- no rows\n')
  })

  test('statements of several batches follow each other', () => {
    const t = target([field('id', 'number')], '"public"."n"')
    expect(body('sql', t, [[['1']], [['2']]])).toBe(
      'INSERT INTO "public"."n" (id) VALUES (1);\nINSERT INTO "public"."n" (id) VALUES (2);\n',
    )
  })
})

describe('export file names', () => {
  test('ASCII name plus extension, path separators and quotes removed', () => {
    expect(exportFileName('page_views', 'csv')).toBe('page_views.csv')
    expect(exportFileName('../../etc/passwd', 'json')).not.toContain('/')
    expect(exportFileName('../../etc/passwd', 'json')).toMatch(/\.json$/)
    expect(exportFileName('a"b c', 'sql')).toBe('a_b_c.sql')
    expect(exportFileName('', 'csv')).toBe('export.csv')
  })
})

describe('view query (shared by the grid and the export)', () => {
  const orders: RelationShape = {
    kind: 'r',
    columns: ['id', 'status', 'name', 'created', 'total'],
    primaryKey: ['id'],
    estimatedRows: 10,
  }
  const none = { filters: [], sort: [] as { column: string; direction: 'asc' | 'desc' }[] }

  test('no view: all rows in primary key order', () => {
    expect(buildViewQuery('public', 'orders', orders, none)).toEqual({
      text: 'SELECT * FROM "public"."orders" ORDER BY "id"',
      values: [],
    })
  })

  test('filters become parameters, nulls use IS NULL, neq is null-safe', () => {
    const q = buildViewQuery('public', 'orders', orders, {
      ...none,
      filters: [
        { column: 'status', op: 'eq', value: 'paid' },
        { column: 'name', op: 'neq', value: 'Ada' },
        { column: 'total', op: 'is_null' },
      ],
    })
    expect(q.text).toBe(
      'SELECT * FROM "public"."orders" WHERE "status" = $1 AND "name" IS DISTINCT FROM $2 AND "total" IS NULL ORDER BY "id"',
    )
    expect(q.values).toEqual(['paid', 'Ada'])
  })

  test('contains escapes LIKE wildcards in the value', () => {
    const q = buildViewQuery('public', 'orders', orders, {
      ...none,
      filters: [{ column: 'name', op: 'contains', value: '50%_off\\x' }],
    })
    expect(q.text).toContain('"name"::text ILIKE $1')
    expect(q.values).toEqual(['%50\\%\\_off\\\\x%'])
  })

  test('starts_with and ends_with put the wildcard on one side', () => {
    const q = buildViewQuery('public', 'orders', orders, {
      ...none,
      filters: [
        { column: 'name', op: 'starts_with', value: 'Ad' },
        { column: 'name', op: 'ends_with', value: 'a' },
      ],
    })
    expect(q.values).toEqual(['Ad%', '%a'])
  })

  test('in splits on commas, trims, drops empties; an empty list matches nothing', () => {
    const q = buildViewQuery('public', 'orders', orders, {
      ...none,
      filters: [{ column: 'status', op: 'in', value: ' paid, shipped,, ' }],
    })
    expect(q.text).toContain('"status"::text = ANY($1::text[])')
    expect(q.values).toEqual([['paid', 'shipped']])
    const empty = buildViewQuery('public', 'orders', orders, {
      ...none,
      filters: [{ column: 'status', op: 'in', value: ' , ' }],
    })
    expect(empty.text).toContain('WHERE false')
  })

  test('raw WHERE is parenthesised and combined with the filters', () => {
    const q = buildViewQuery('public', 'orders', orders, {
      ...none,
      filters: [{ column: 'status', op: 'eq', value: 'paid' }],
      where: 'total > 10 OR total IS NULL',
    })
    expect(q.text).toContain('WHERE "status" = $1 AND (total > 10 OR total IS NULL)')
  })

  test('full-text search matches any column', () => {
    const q = buildViewQuery('public', 'orders', orders, { ...none, search: ' ada ' })
    expect(q.text).toContain(
      '("id"::text ILIKE $1 OR "status"::text ILIKE $1 OR "name"::text ILIKE $1 OR "created"::text ILIKE $1 OR "total"::text ILIKE $1)',
    )
    expect(q.values).toEqual(['%ada%'])
  })

  test('an explicit sort replaces the primary key order', () => {
    const q = buildViewQuery('public', 'orders', orders, {
      filters: [],
      sort: [
        { column: 'created', direction: 'desc' },
        { column: 'id', direction: 'asc' },
      ],
    })
    expect(q.text).toBe('SELECT * FROM "public"."orders" ORDER BY "created" DESC NULLS LAST, "id" ASC NULLS FIRST')
  })

  test('a table without a primary key is ordered by ctid, and the grid can ask for ctid', () => {
    const heap: RelationShape = { ...orders, primaryKey: [] }
    expect(usesCtid(heap)).toBe(true)
    expect(buildViewQuery('public', 'orders', heap, none).text).toBe('SELECT * FROM "public"."orders" ORDER BY ctid')
    expect(buildViewQuery('public', 'orders', heap, none, { withCtid: true }).text).toBe(
      'SELECT *, ctid FROM "public"."orders" ORDER BY ctid',
    )
  })

  test('a view is not ordered unless asked, and has no ctid', () => {
    const view: RelationShape = { ...orders, kind: 'v', primaryKey: [] }
    expect(usesCtid(view)).toBe(false)
    expect(buildViewQuery('public', 'v_orders', view, none).text).toBe('SELECT * FROM "public"."v_orders"')
  })

  test('a filter, sort or search on an unknown column is rejected before any SQL is built', () => {
    expect(() =>
      buildViewQuery('public', 'orders', orders, { ...none, filters: [{ column: 'nope', op: 'eq', value: 'x' }] }),
    ).toThrow('Unknown column "nope"')
    expect(() =>
      buildViewQuery('public', 'orders', orders, { filters: [], sort: [{ column: 'nope', direction: 'asc' }] }),
    ).toThrow('Unknown column "nope"')
  })

  test('column names are quoted, so a quote in a name cannot break out', () => {
    const odd: RelationShape = { kind: 'r', columns: ['a"b'], primaryKey: ['a"b'], estimatedRows: null }
    const q = buildViewQuery('public', 'odd', odd, { filters: [{ column: 'a"b', op: 'eq', value: 'x' }], sort: [] })
    expect(q.text).toBe('SELECT * FROM "public"."odd" WHERE "a""b" = $1 ORDER BY "a""b"')
  })
})

describe('export request parsing', () => {
  const url = (query: string) => new Request(`http://localhost:3335/api/export/table?${query}`)
  const base = 'connection=c1&schema=public&table=orders'

  test('reads the grid state: filters, search, sort, where, database', () => {
    const filters = encodeURIComponent(JSON.stringify([{ column: 'status', op: 'eq', value: 'paid' }]))
    const sort = encodeURIComponent(JSON.stringify([{ column: 'id', direction: 'desc' }]))
    const req = parseTableExportRequest(
      url(`${base}&format=ndjson&database=shop&filters=${filters}&sort=${sort}&q=ada&where=total%3E10`),
    )
    expect(req).toEqual({
      connection: 'c1',
      database: 'shop',
      schema: 'public',
      table: 'orders',
      format: 'ndjson',
      view: {
        filters: [{ column: 'status', op: 'eq', value: 'paid' }],
        sort: [{ column: 'id', direction: 'desc' }],
        where: 'total>10',
        search: 'ada',
      },
    })
  })

  test('no view state means no filters and no sort', () => {
    const req = parseTableExportRequest(url(`${base}&format=csv`))
    expect(req.view).toEqual({ filters: [], sort: [], where: undefined, search: undefined })
    expect(req.database).toBeUndefined()
  })

  const expectHttp = (fn: () => unknown, status: number) => {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).status).toBe(status)
      return
    }
    throw new Error('expected an HttpError')
  }

  test('unknown format, missing parameters and bad JSON are 400', () => {
    expectHttp(() => parseTableExportRequest(url(`${base}&format=xlsx`)), 400)
    expectHttp(() => parseTableExportRequest(url('schema=public&table=orders&format=csv')), 400)
    expectHttp(() => parseTableExportRequest(url('connection=c1&table=orders&format=csv')), 400)
    expectHttp(() => parseTableExportRequest(url(`${base}&format=csv&filters=%5Bnot-json`)), 400)
  })

  test('filters must use a known operator and a column name', () => {
    const bad = encodeURIComponent(JSON.stringify([{ column: 'status', op: 'drop_table' }]))
    expectHttp(() => parseTableExportRequest(url(`${base}&format=csv&filters=${bad}`)), 400)
    const noColumn = encodeURIComponent(JSON.stringify([{ op: 'eq', value: 'x' }]))
    expectHttp(() => parseTableExportRequest(url(`${base}&format=csv&filters=${noColumn}`)), 400)
  })

  test('an oversized WHERE is refused', () => {
    expectHttp(() => parseTableExportRequest(url(`${base}&format=csv&where=${'x'.repeat(10_001)}`)), 400)
  })
})
