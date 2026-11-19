import { describe, expect, test } from 'bun:test'
import { classifySql } from './sql-safety'

describe('classifySql: read-only', () => {
  test.each([
    ['select 1', ['SELECT']],
    ['SELECT * FROM orders WHERE id = 1;', ['SELECT']],
    ["select 'delete from x'", ['SELECT']],
    ['select * from "delete"', ['SELECT']],
    ['select 1 for update', ['SELECT']],
    ['(select 1) union (select 2)', ['SELECT']],
    ['select $1', ['SELECT']],
    ['-- note\n/* outer /* nested */ still comment */ select 1', ['SELECT']],
    ['with a as (select 1) select * from a', ['WITH']],
    ['show search_path', ['SHOW']],
    ['values (1), (2)', ['VALUES']],
    ['table orders', ['TABLE']],
    ['fetch 10 from c', ['FETCH']],
    ['begin', ['BEGIN']],
    ['start transaction', ['START']],
    ['commit', ['COMMIT']],
    ['rollback', ['ROLLBACK']],
    ['set search_path to app', ['SET']],
    ['reset all', ['RESET']],
    ['discard all', ['DISCARD']],
    ['declare c cursor for select 1', ['DECLARE']],
    ['close c', ['CLOSE']],
    ['listen channel_one', ['LISTEN']],
    ['explain delete from t', ['EXPLAIN']],
    ['explain analyze select 1', ['EXPLAIN', 'SELECT']],
    ['explain (analyze, buffers) select * from t', ['EXPLAIN', 'SELECT']],
  ])('%s is read-only', (sql, commands) => {
    expect(classifySql(sql)).toEqual({ changes: false, destructive: false, commands })
  })

  test('several read-only statements stay read-only', () => {
    expect(classifySql('select 1; show work_mem; select 2')).toEqual({
      changes: false,
      destructive: false,
      commands: ['SELECT', 'SHOW', 'SELECT'],
    })
  })

  test('empty input and comment-only input change nothing', () => {
    expect(classifySql('')).toEqual({ changes: false, destructive: false, commands: [] })
    expect(classifySql('  -- just a comment\n')).toEqual({ changes: false, destructive: false, commands: [] })
  })

  test('a WITH that only reads is read-only, even with a comment word inside', () => {
    expect(classifySql('with x as (select 1 /* delete */) select * from x').changes).toBe(false)
  })
})

describe('classifySql: changes that are not destructive', () => {
  test.each([
    ['insert into t values (1)', ['INSERT']],
    ['insert into t (id) values (1) on conflict (id) do update set x = 1', ['INSERT']],
    ['select * into new_t from t', ['SELECT']],
    ['create table t (id int)', ['CREATE']],
    ['create table c (id int references p (id) on delete cascade)', ['CREATE']],
    ['alter table t rename column a to b', ['ALTER']],
    ['alter table t add column x int', ['ALTER']],
    ['update t set a = 1 where id = 2', ['UPDATE']],
    ['delete from t where id in (select id from u)', ['DELETE']],
    ['savepoint sp1', ['SAVEPOINT']],
    ['copy t from stdin', ['COPY']],
    ['do $$ begin perform 1; end $$', ['DO']],
    ['explain (analyze, buffers) update t set a = 1 where id = 1', ['EXPLAIN', 'UPDATE']],
    ['with d as (delete from t where id = 1 returning *) select * from d', ['WITH']],
    ['with x as (select 1 for update) select * from x', ['WITH']],
  ])('%s changes data but is not destructive', (sql, commands) => {
    const result = classifySql(sql)
    expect(result.changes).toBe(true)
    expect(result.destructive).toBe(false)
    expect(result.commands).toEqual(commands)
  })
})

describe('classifySql: destructive', () => {
  test.each([
    ['drop table t', ['DROP']],
    ['drop view if exists v', ['DROP']],
    ['truncate t', ['TRUNCATE']],
    ['truncate table a, b cascade', ['TRUNCATE']],
    ['delete from t', ['DELETE']],
    ['update t set a = 1', ['UPDATE']],
    ['update t set a = (select 1 where true)', ['UPDATE']],
    ['alter table t drop column c', ['ALTER']],
    ['alter table t drop constraint t_pkey', ['ALTER']],
    ['explain analyze delete from t', ['EXPLAIN', 'DELETE']],
    ['with a as (delete from t returning *) select * from a', ['WITH']],
    ['with x as (select 1) update t set a = 1', ['WITH']],
    ['merge into t using s on t.id = s.id when matched then delete', ['MERGE']],
    ['do $$ begin drop table t; end $$', ['DO']],
  ])('%s is destructive', (sql, commands) => {
    const result = classifySql(sql)
    expect(result.changes).toBe(true)
    expect(result.destructive).toBe(true)
    expect(result.commands).toEqual(commands)
  })

  test('a script is destructive when any statement is', () => {
    expect(classifySql('select 1; drop table t')).toEqual({
      changes: true,
      destructive: true,
      commands: ['SELECT', 'DROP'],
    })
  })
})

describe('classifySql: unknown or unparsable is a change', () => {
  test.each([
    ["select 'abc"],
    ['/* never closed select 1'],
    ['select "name'],
    ['grant select on t to reader'],
    ['some_unknown_command'],
    ['(delete from t)'],
    ['explain analyze'],
  ])('%s', (sql) => {
    expect(classifySql(sql).changes).toBe(true)
  })
})

describe('classifySql: a line comment ends at CR or LF', () => {
  test('a lone CR ends the comment, so the DELETE after it is seen', () => {
    expect(classifySql('select 1 -- x\r; delete from t')).toEqual({
      changes: true,
      destructive: true,
      commands: ['SELECT', 'DELETE'],
    })
  })

  test('a CRLF ending still ends the comment', () => {
    expect(classifySql('select 1 -- x\r\n; delete from t')).toEqual({
      changes: true,
      destructive: true,
      commands: ['SELECT', 'DELETE'],
    })
  })

  test('a CR inside a comment does not hide a read-only script', () => {
    expect(classifySql('-- note\rselect 1')).toEqual({ changes: false, destructive: false, commands: ['SELECT'] })
  })
})
