import { describe, expect, test } from 'bun:test'
import { formatPlanNumber, parsePlan } from './explain'

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
      'Read the whole table and threw away 50K rows. An index on the filtered columns may help.',
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
      'Postgres expected 10 rows but got 500. Running ANALYZE on the table updates its statistics.',
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
      'The sort did not fit in memory and used 500 kB of disk. A higher work_mem may help.',
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
    expect(parsed.nodes[0]!.warnings).toEqual(['The hash table did not fit in memory and was split into 4 batches.'])
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
      'Read the whole table and threw away 50K rows. An index on the filtered columns may help.',
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
