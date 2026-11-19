import { describe, expect, test } from 'bun:test'
import { readOnlyViolation } from './execute.server'

const check = (...sqls: string[]) => readOnlyViolation(sqls.map((text) => ({ text })))

describe('readOnlyViolation allows reads', () => {
  test.each([
    ['select 1'],
    ['WITH x AS (SELECT 1) SELECT * FROM x'],
    ['EXPLAIN SELECT 1'],
    ['SHOW search_path'],
    ['SET search_path = public'],
    ['SET statement_timeout = 1000'],
    ['VALUES (1)'],
    ['TABLE users'],
    ['-- comment\nSELECT 1'],
    ['/* note */ select 1'],
  ])('%s', (sql) => {
    expect(check(sql)).toBe(-1)
  })
})

describe('readOnlyViolation refuses transaction statements', () => {
  test.each([
    ['begin'],
    ['BEGIN READ WRITE'],
    ['start transaction'],
    ['commit'],
    ['end'],
    ['rollback'],
    ['abort'],
    ['savepoint x'],
    ['release x'],
    ["prepare transaction 'x'"],
    ['set transaction read write'],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE'],
    ['-- note\n  Commit'],
  ])('%s', (sql) => {
    expect(check(sql)).toBe(0)
  })

  test('reports the index of the first refused statement', () => {
    expect(check('select 1', 'rollback', 'select 2')).toBe(1)
  })
})
