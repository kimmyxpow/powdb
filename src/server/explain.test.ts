import { describe, expect, test } from 'bun:test'
import { explainSql } from './execute.server'

// Only the checks that run before any connection is opened are tested here.
const run = (sql: string) =>
  explainSql('no-such-connection', 'no-such-db', sql, { analyze: false, executionId: 'test' })

describe('explainSql input checks', () => {
  test('empty input gives an empty result', async () => {
    const out = await run('   \n ')
    expect(out.error).toBeNull()
    expect(out.plan).toBeNull()
    expect(out.results).toEqual([])
  })

  test('more than one statement is refused', async () => {
    const out = await run('select 1; select 2')
    expect(out.error).toEqual({
      message: 'Explain works on one statement at a time. Put the cursor in a statement or select it.',
      statementIndex: -1,
      from: 0,
      to: 0,
    })
  })

  test('a statement that already starts with EXPLAIN is refused', async () => {
    const out = await run('explain select 1')
    expect(out.error?.message).toBe('Remove EXPLAIN from the statement. The Explain button adds it.')
    expect(out.error?.statementIndex).toBe(0)
    expect(out.error?.to).toBe('explain select 1'.length)
  })
})
