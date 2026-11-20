import { describe, expect, test } from 'bun:test'
import { formatPlanNumber, isExplainable, parsePlan, suggestIndex } from './explain'
import type { KnownTable } from './explain'

const plainPlan = {
  Plan: {
    'Node Type': 'Hash Join',
    'Join Type': 'Inner',
    'Plan Rows': 100,
    'Total Cost': 200,
    'Hash Cond': '(o.customer_id = c.id)',
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        Alias: 'o',
        'Plan Rows': 1000,
        'Total Cost': 120,
        Filter: "(status = 'paid')",
      },
      {
        'Node Type': 'Hash',
        'Plan Rows': 50,
        'Total Cost': 60,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'customers',
            Alias: 'customers',
            'Plan Rows': 50,
            'Total Cost': 30,
          },
        ],
      },
    ],
  },
}

/** A plan as EXPLAIN (ANALYZE) writes it: times are per loop, so the parser multiplies them. */
const analyzedPlan = {
  Plan: {
    'Node Type': 'Nested Loop',
    'Join Type': 'Left',
    'Plan Rows': 10,
    'Total Cost': 500,
    'Actual Total Time': 100,
    'Actual Rows': 10,
    'Actual Loops': 1,
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        'Plan Rows': 10,
        'Total Cost': 300,
        'Actual Total Time': 40,
        'Actual Rows': 5,
        'Actual Loops': 1,
      },
      {
        'Node Type': 'Index Scan',
        'Index Name': 'customers_pkey',
        'Relation Name': 'customers',
        Alias: 'c',
        'Plan Rows': 1,
        'Total Cost': 200,
        'Actual Total Time': 2,
        'Actual Rows': 1,
        'Actual Loops': 5,
      },
    ],
  },
  'Planning Time': 0.1,
  'Execution Time': 100.5,
}

/** Builds a one-node analyzed plan, to test the warnings in isolation. */
function leaf(fields: Record<string, unknown>) {
  return {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 't',
      'Plan Rows': 10,
      'Total Cost': 50,
      'Actual Total Time': 1,
      'Actual Rows': 10,
      'Actual Loops': 1,
      ...fields,
    },
  }
}

describe('parsePlan on a plain plan', () => {
  const parsed = parsePlan(plainPlan, false)

  test('lists the steps depth-first with titles and details', () => {
    expect(parsed.nodes.map((n) => [n.id, n.depth, n.title])).toEqual([
      [0, 0, 'Hash Join (inner)'],
      [1, 1, 'Seq Scan on orders o'],
      [2, 1, 'Hash'],
      [3, 2, 'Seq Scan on customers'],
    ])
    expect(parsed.nodes[0]!.detail).toEqual(['Hash Cond: (o.customer_id = c.id)'])
    expect(parsed.nodes[1]!.detail).toEqual(["Filter: (status = 'paid')"])
    expect(parsed.nodes[1]!.raw).not.toHaveProperty('Plans')
  })

  test('uses cost shares when not analyzed', () => {
    expect(parsed.analyzed).toBe(false)
    expect(parsed.totalCost).toBe(200)
    expect(parsed.nodes.map((n) => n.selfCost)).toEqual([20, 120, 30, 30])
    expect(parsed.nodes.map((n) => n.share)).toEqual([0.1, 0.6, 0.15, 0.15])
    expect(parsed.nodes.every((n) => n.selfMs === null && n.actualRows === null && n.loops === null)).toBe(true)
    expect(parsed.nodes.every((n) => !n.neverExecuted)).toBe(true)
  })

  test('marks the step with the largest share as slowest when it is at least 20%', () => {
    expect(parsed.slowestId).toBe(1)
  })

  test('reports no slowest step when every step is below 20%', () => {
    const children = Array.from({ length: 6 }, () => ({ 'Node Type': 'Result', 'Plan Rows': 1, 'Total Cost': 10 }))
    const flat = parsePlan(
      { Plan: { 'Node Type': 'Append', 'Plan Rows': 6, 'Total Cost': 60, Plans: children } },
      false,
    )
    expect(flat.slowestId).toBeNull()
  })
})

describe('parsePlan on an analyzed nested plan', () => {
  const parsed = parsePlan(analyzedPlan, true)

  test('reads the planning and execution times', () => {
    expect(parsed.analyzed).toBe(true)
    expect(parsed.planningMs).toBe(0.1)
    expect(parsed.executionMs).toBe(100.5)
  })

  test('takes a step its own time: total minus the children, with loops counted', () => {
    // the index scan ran 5 times at 2 ms each, so it took 10 ms in total
    expect(parsed.nodes.map((n) => n.selfMs)).toEqual([50, 40, 10])
  })

  test('gives each step its share of the measured time', () => {
    expect(parsed.nodes.map((n) => n.share)).toEqual([0.5, 0.4, 0.1])
    expect(parsed.slowestId).toBe(0)
  })

  test('multiplies the actual and estimated rows by the loop count', () => {
    expect(parsed.nodes[2]!.actualRows).toBe(5)
    expect(parsed.nodes[2]!.loops).toBe(5)
    // Plan Rows is per loop too: 1 row on each of 5 loops
    expect(parsed.nodes[2]!.estRows).toBe(5)
    expect(parsed.nodes[2]!.title).toBe('Index Scan using customers_pkey on customers c')
    expect(parsed.nodes[0]!.title).toBe('Nested Loop (left)')
  })

  test('clamps the step time to zero when the children took longer', () => {
    const odd = parsePlan(
      {
        Plan: {
          'Node Type': 'Result',
          'Plan Rows': 1,
          'Total Cost': 1,
          'Actual Total Time': 1,
          'Actual Rows': 1,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Result',
              'Plan Rows': 1,
              'Total Cost': 1,
              'Actual Total Time': 5,
              'Actual Rows': 1,
              'Actual Loops': 1,
            },
          ],
        },
      },
      true,
    )
    expect(odd.nodes[0]!.selfMs).toBe(0)
  })
})

describe('plan warnings', () => {
  test('a seq scan that threw away many rows', () => {
    const parsed = parsePlan(leaf({ 'Rows Removed by Filter': 50000, 'Actual Rows': 20 }), true)
    expect(parsed.nodes[0]!.warnings).toEqual([
      {
        kind: 'full-scan',
        text: 'Read the whole table and threw away 50K rows. An index on the filtered columns may help.',
      },
    ])
  })

  test('no seq scan warning when few rows were thrown away', () => {
    const parsed = parsePlan(leaf({ 'Rows Removed by Filter': 500, 'Actual Rows': 20 }), true)
    expect(parsed.nodes[0]!.warnings).toEqual([])
  })

  test('no seq scan warning when the scan kept most rows', () => {
    const parsed = parsePlan(leaf({ 'Plan Rows': 5000, 'Rows Removed by Filter': 20000, 'Actual Rows': 5000 }), true)
    expect(parsed.nodes[0]!.warnings).toEqual([])
  })

  test('a bad row estimate', () => {
    const parsed = parsePlan(leaf({ 'Plan Rows': 10, 'Actual Rows': 500 }), true)
    expect(parsed.nodes[0]!.warnings).toEqual([
      {
        kind: 'estimate',
        text: 'Postgres expected 10 rows but got 500. Running ANALYZE on the table updates its statistics.',
      },
    ])
  })

  test('a bad estimate on a small count is not warned about', () => {
    const parsed = parsePlan(leaf({ 'Plan Rows': 1, 'Actual Rows': 50 }), true)
    expect(parsed.nodes[0]!.warnings).toEqual([])
  })

  test('a sort that spilled to disk', () => {
    const parsed = parsePlan(
      {
        Plan: {
          'Node Type': 'Sort',
          'Sort Key': ['a', 'b'],
          'Plan Rows': 1,
          'Total Cost': 1,
          'Sort Space Type': 'Disk',
          'Sort Space Used': 500,
        },
      },
      false,
    )
    expect(parsed.nodes[0]!.detail).toEqual(['Sort Key: a, b'])
    expect(parsed.nodes[0]!.warnings).toEqual([
      {
        kind: 'disk-sort',
        text: 'The sort did not fit in memory and used 500 kB of disk. A higher work_mem may help.',
      },
    ])
  })

  test('a sort in memory is not warned about', () => {
    const parsed = parsePlan(
      {
        Plan: {
          'Node Type': 'Sort',
          'Plan Rows': 1,
          'Total Cost': 1,
          'Sort Space Type': 'Memory',
          'Sort Space Used': 500,
        },
      },
      false,
    )
    expect(parsed.nodes[0]!.warnings).toEqual([])
  })

  test('a hash table split into batches', () => {
    const parsed = parsePlan(
      { Plan: { 'Node Type': 'Hash', 'Plan Rows': 1, 'Total Cost': 1, 'Hash Batches': 4 } },
      false,
    )
    expect(parsed.nodes[0]!.warnings).toEqual([
      { kind: 'hash-batches', text: 'The hash table did not fit in memory and was split into 4 batches.' },
    ])
  })
})

describe('steps inside a loop', () => {
  test('rows are compared per loop, so a step run many times is not flagged', () => {
    // 1 row expected and 1 row found on each of 5000 loops
    const parsed = parsePlan(leaf({ 'Plan Rows': 1, 'Actual Rows': 1, 'Actual Loops': 5000 }), true)
    expect(parsed.nodes[0]!.estRows).toBe(5000)
    expect(parsed.nodes[0]!.actualRows).toBe(5000)
    expect(parsed.nodes[0]!.warnings).toEqual([])
  })

  test('rows thrown away are counted over every loop', () => {
    const parsed = parsePlan(
      leaf({ 'Plan Rows': 1, 'Actual Rows': 1, 'Actual Loops': 100, 'Rows Removed by Filter': 500 }),
      true,
    )
    expect(parsed.nodes[0]!.warnings).toEqual([
      {
        kind: 'full-scan',
        text: 'Read the whole table and threw away 50K rows. An index on the filtered columns may help.',
      },
    ])
  })

  test('a step that never ran gets no warnings', () => {
    const parsed = parsePlan(leaf({ 'Plan Rows': 5000, 'Actual Rows': 0, 'Actual Loops': 0 }), true)
    expect(parsed.nodes[0]!.neverExecuted).toBe(true)
    expect(parsed.nodes[0]!.warnings).toEqual([])
  })
})

describe('titles and the slowest step', () => {
  test('a write is named after its operation', () => {
    const parsed = parsePlan(
      leaf({ 'Node Type': 'ModifyTable', Operation: 'Insert', 'Relation Name': 'categories' }),
      true,
    )
    expect(parsed.nodes[0]!.title).toBe('Insert on categories')
  })

  test('no step is marked slowest when the whole query took under a millisecond', () => {
    const parsed = parsePlan(leaf({ 'Actual Total Time': 0.2 }), true)
    expect(parsed.slowestId).toBeNull()
  })
})

describe('steps below a Limit', () => {
  const limited = (child: Record<string, unknown>) => ({
    Plan: {
      'Node Type': 'Limit',
      'Plan Rows': 20,
      'Total Cost': 10,
      'Actual Total Time': 1,
      'Actual Rows': 20,
      'Actual Loops': 1,
      Plans: [{ ...leaf({}).Plan, ...child }],
    },
  })

  test('fewer rows than planned is not flagged, since the Limit stops reading early', () => {
    const parsed = parsePlan(limited({ 'Plan Rows': 5000, 'Actual Rows': 20 }), true)
    expect(parsed.nodes[1]!.warnings).toEqual([])
  })

  test('more rows than planned is still flagged', () => {
    const parsed = parsePlan(limited({ 'Plan Rows': 10, 'Actual Rows': 5000 }), true)
    expect(parsed.nodes[1]!.warnings).toHaveLength(1)
  })
})

describe('never executed steps', () => {
  test('a step with zero loops is marked and has no time', () => {
    const parsed = parsePlan(
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Plan Rows': 1,
          'Total Cost': 10,
          'Actual Total Time': 3,
          'Actual Rows': 1,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'never',
              'Plan Rows': 1,
              'Total Cost': 5,
              'Actual Total Time': 0,
              'Actual Rows': 0,
              'Actual Loops': 0,
            },
          ],
        },
      },
      true,
    )
    expect(parsed.nodes[1]!.neverExecuted).toBe(true)
    expect(parsed.nodes[1]!.selfMs).toBe(0)
    expect(parsed.nodes[0]!.neverExecuted).toBe(false)
  })
})

describe('parsePlan rejects bad input', () => {
  test.each([
    ['null', null],
    ['a string', 'plan'],
    ['an empty object', {}],
    ['a plan without a node type', { Plan: { 'Plan Rows': 1, 'Total Cost': 1 } }],
    ['a plan without costs', { Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 1 } }],
    [
      'a children list that is not a list',
      { Plan: { 'Node Type': 'Append', 'Plan Rows': 1, 'Total Cost': 1, Plans: 'x' } },
    ],
  ])('%s', (_label, raw) => {
    expect(() => parsePlan(raw, false)).toThrow('Could not read the plan')
  })

  test('an analyzed plan without timings', () => {
    expect(() => parsePlan({ Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 1, 'Total Cost': 1 } }, true)).toThrow(
      'Could not read the plan',
    )
  })
})

describe('suggestIndex column order', () => {
  const table = { schema: 'analytics', name: 'page_views', columns: ['id', 'duration_ms', 'country_code', 'path'] }
  const scan = (filter: string) =>
    parsePlan(
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'page_views',
          'Plan Rows': 1,
          'Total Cost': 600,
          'Actual Total Time': 20,
          'Actual Rows': 0,
          'Actual Loops': 1,
          'Rows Removed by Filter': 25000,
          Filter: filter,
        },
      },
      true,
    ).nodes[0]!

  test('columns compared by equality come before range columns', () => {
    expect(suggestIndex(scan("((duration_ms > 100) AND (country_code = 'ZZ'::bpchar))"), [table])).toBe(
      'CREATE INDEX CONCURRENTLY ON "analytics"."page_views" ("country_code", "duration_ms");',
    )
  })

  test('>= and <= count as range comparisons', () => {
    expect(suggestIndex(scan("((duration_ms >= 100) AND (path = '/a'::text))"), [table])).toBe(
      'CREATE INDEX CONCURRENTLY ON "analytics"."page_views" ("path", "duration_ms");',
    )
  })
})

describe('formatPlanNumber', () => {
  test.each([
    [1234567, '1.2M'],
    [2000000, '2M'],
    [12345, '12.3K'],
    [12000, '12K'],
    [999, '999'],
    [1.5, '1.5'],
    [0, '0'],
    [-2500, '-2.5K'],
  ])('%p -> %s', (n, text) => {
    expect(formatPlanNumber(n)).toBe(text)
  })
})

describe('isExplainable', () => {
  test('accepts statements that EXPLAIN can take', () => {
    for (const sql of [
      'select 1',
      'SELECT * FROM orders',
      'with x as (select 1) select * from x',
      'insert into t values (1)',
      'update t set a = 1',
      'delete from t',
      'merge into t using s on true when matched then delete',
      'values (1), (2)',
      'table orders',
    ]) {
      expect(isExplainable(sql)).toBe(true)
    }
  })

  test('skips leading spaces, comments and parens', () => {
    expect(isExplainable('   \n select 1')).toBe(true)
    expect(isExplainable('-- note\nselect 1')).toBe(true)
    expect(isExplainable('/* note */ select 1')).toBe(true)
    expect(isExplainable('(select 1) union (select 2)')).toBe(true)
  })

  test('refuses other statements and empty text', () => {
    expect(isExplainable('')).toBe(false)
    expect(isExplainable('   ')).toBe(false)
    expect(isExplainable('-- only a comment')).toBe(false)
    expect(isExplainable('create table t (a int)')).toBe(false)
    expect(isExplainable('set search_path = public')).toBe(false)
    expect(isExplainable('vacuum analyze orders')).toBe(false)
    expect(isExplainable('explain select 1')).toBe(false)
    expect(isExplainable('$1')).toBe(false)
  })
})

describe('suggestIndex', () => {
  const tables: KnownTable[] = [
    {
      schema: 'public',
      name: 'orders',
      columns: ['id', 'status', 'customer_id', 'country_code', 'email', 'note', 'My Col'],
    },
  ]

  /** A seq scan on orders that read the whole table and kept few rows, with the given filter. */
  function scan(filter: string | null, extra: Record<string, unknown> = {}) {
    const fields: Record<string, unknown> = {
      'Relation Name': 'orders',
      'Rows Removed by Filter': 50000,
      'Actual Rows': 20,
      ...extra,
    }
    if (filter !== null) fields.Filter = filter
    return parsePlan(leaf(fields), true).nodes[0]!
  }

  test('suggests an index on a simple equality', () => {
    expect(suggestIndex(scan("(status = 'paid'::order_status)"), tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("status");',
    )
  })

  test('uses the column under a cast', () => {
    expect(suggestIndex(scan("((country_code)::text = 'ZZ'::text)"), tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("country_code");',
    )
  })

  test('suggests two columns joined with AND, in order', () => {
    expect(suggestIndex(scan("((status = 'paid'::order_status) AND (customer_id = 5))"), tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("status", "customer_id");',
    )
  })

  test('quotes a column name that needs quotes', () => {
    expect(suggestIndex(scan('("My Col" = 1)'), tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("My Col");',
    )
  })

  test('reads a doubled quote inside a quoted column name', () => {
    const quoted: KnownTable[] = [{ schema: 'public', name: 'orders', columns: ['a"b'] }]
    expect(suggestIndex(scan('("a""b" = 1)'), quoted)).toBe('CREATE INDEX CONCURRENTLY ON "public"."orders" ("a""b");')
  })

  test('gives nothing for only <> or !=', () => {
    expect(suggestIndex(scan("(status <> 'paid'::order_status)"), tables)).toBeNull()
    expect(suggestIndex(scan('(id != 4)'), tables)).toBeNull()
  })

  test('gives nothing for OR', () => {
    expect(suggestIndex(scan("((status = 'a') OR (status = 'b'))"), tables)).toBeNull()
  })

  test('gives nothing for a function call on the column', () => {
    expect(suggestIndex(scan("(lower((email)::text) = 'x@example.com'::text)"), tables)).toBeNull()
  })

  test('allows ANY with an array literal', () => {
    expect(suggestIndex(scan("(status = ANY ('{a,b}'::text[]))"), tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("status");',
    )
  })

  test('does not read a column name inside a literal', () => {
    expect(suggestIndex(scan("(note = 'status'::text)"), tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("note");',
    )
  })

  test('uses a column for IS NULL', () => {
    expect(suggestIndex(scan('(note IS NULL)'), tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("note");',
    )
  })

  test('skips a type name made of several words, and the qualifier before a dot', () => {
    const cast = scan("((o.email)::character varying(255) = 'x'::character varying)")
    expect(suggestIndex(cast, tables)).toBe('CREATE INDEX CONCURRENTLY ON "public"."orders" ("email");')
  })

  test('gives nothing when the table is not known', () => {
    expect(suggestIndex(scan("(status = 'paid')"), [])).toBeNull()
  })

  test('gives nothing when the same name is in two schemas and none is public', () => {
    const two: KnownTable[] = [
      { schema: 'sales', name: 'orders', columns: ['status'] },
      { schema: 'archive', name: 'orders', columns: ['status'] },
    ]
    expect(suggestIndex(scan("(status = 'paid')"), two)).toBeNull()
  })

  test('prefers public when the same name is in several schemas', () => {
    const two: KnownTable[] = [
      { schema: 'archive', name: 'orders', columns: ['status'] },
      { schema: 'public', name: 'orders', columns: ['status'] },
    ]
    expect(suggestIndex(scan("(status = 'paid')"), two)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("status");',
    )
  })

  test('gives nothing without a full-scan warning', () => {
    const quiet = scan("(status = 'paid')", { 'Rows Removed by Filter': 5 })
    expect(quiet.warnings.some((w) => w.kind === 'full-scan')).toBe(false)
    expect(suggestIndex(quiet, tables)).toBeNull()
  })

  test('gives nothing for a column the table does not have', () => {
    expect(suggestIndex(scan("(nope = 'x')"), tables)).toBeNull()
  })

  test('suggests at most three columns', () => {
    const four = scan("((id = 1) AND (status = 'a') AND (customer_id = 2) AND (email = 'x'))")
    expect(suggestIndex(four, tables)).toBe(
      'CREATE INDEX CONCURRENTLY ON "public"."orders" ("id", "status", "customer_id");',
    )
  })
})
