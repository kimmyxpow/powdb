import { describe, expect, test } from 'bun:test'
import { displayIdent, displayQualified, quoteIdent, quoteLiteral, splitStatements, statementAt } from './sql'

describe('quoteIdent', () => {
  test.each([
    ['plain', '"plain"'],
    ['Mixed Case', '"Mixed Case"'],
    ['a"b', '"a""b"'],
    ['""', '""""""'],
  ])('%s', (name, quoted) => {
    expect(quoteIdent(name)).toBe(quoted)
  })
})

describe('quoteLiteral', () => {
  test.each([
    ['plain', "'plain'"],
    ["it's", "'it''s'"],
    ['a\\b', "E'a\\\\b'"],
    ["x\\y'z", "E'x\\\\y''z'"],
  ])('%s', (value, literal) => {
    expect(quoteLiteral(value)).toBe(literal)
  })
})

describe('displayIdent', () => {
  test.each([
    ['users', 'users'],
    ['_tmp1', '_tmp1'],
    ['Users', '"Users"'],
    ['select', '"select"'],
    ['user', '"user"'],
    ['my table', '"my table"'],
    ['1st', '"1st"'],
    ['a"b', '"a""b"'],
  ])('%s', (name, shown) => {
    expect(displayIdent(name)).toBe(shown)
  })

  test.each([
    ['public', 'users', 'users'],
    ['app', 'users', 'app.users'],
    ['public', 'Users', '"Users"'],
    ['app', 'Order', 'app."Order"'],
  ])('displayQualified(%s, %s)', (schema, name, shown) => {
    expect(displayQualified(schema, name)).toBe(shown)
  })
})

describe('splitStatements: separators inside quotes', () => {
  test("a semicolon inside '' stays in the statement", () => {
    expect(splitStatements("select 'x;y' as v; select 2")).toEqual([
      { text: "select 'x;y' as v", from: 0, to: 17 },
      { text: 'select 2', from: 19, to: 27 },
    ])
  })

  test("a doubled '' does not end the string", () => {
    expect(splitStatements("select 'it''s;x'; select 2")).toEqual([
      { text: "select 'it''s;x'", from: 0, to: 16 },
      { text: 'select 2', from: 18, to: 26 },
    ])
  })

  test('a semicolon inside "" stays in the statement', () => {
    expect(splitStatements('select "a;b" from t; select 2')).toEqual([
      { text: 'select "a;b" from t', from: 0, to: 19 },
      { text: 'select 2', from: 21, to: 29 },
    ])
  })

  test('a semicolon inside $$ ... $$ stays in the statement', () => {
    expect(splitStatements('do $$ begin perform 1; end $$; select 1')).toEqual([
      { text: 'do $$ begin perform 1; end $$', from: 0, to: 29 },
      { text: 'select 1', from: 31, to: 39 },
    ])
  })

  test('a $tag$ body only closes on the same tag', () => {
    expect(splitStatements('do $a$ $b$ ; $b$ ; $a$; select 1')).toEqual([
      { text: 'do $a$ $b$ ; $b$ ; $a$', from: 0, to: 22 },
      { text: 'select 1', from: 24, to: 32 },
    ])
  })

  test("E'' strings honour backslash escapes", () => {
    expect(splitStatements("select E'it\\'s; x'; select 2")).toEqual([
      { text: "select E'it\\'s; x'", from: 0, to: 18 },
      { text: 'select 2', from: 20, to: 28 },
    ])
  })

  test('a plain string does not treat a backslash as an escape', () => {
    expect(splitStatements("select 'a\\'; select 2")).toEqual([
      { text: "select 'a\\'", from: 0, to: 11 },
      { text: 'select 2', from: 13, to: 21 },
    ])
  })

  test('positional parameters are not dollar quotes', () => {
    expect(splitStatements('select $1, $2; select 2')).toEqual([
      { text: 'select $1, $2', from: 0, to: 13 },
      { text: 'select 2', from: 15, to: 23 },
    ])
  })
})

describe('splitStatements: comments', () => {
  test('a line comment ends at LF, so a semicolon after it splits', () => {
    expect(splitStatements('select 1 -- a; b\n; select 2')).toEqual([
      { text: 'select 1 -- a; b', from: 0, to: 16 },
      { text: 'select 2', from: 19, to: 27 },
    ])
  })

  test('a line comment ends at a lone CR', () => {
    expect(splitStatements('select 1 -- a; b\r; select 2')).toEqual([
      { text: 'select 1 -- a; b', from: 0, to: 16 },
      { text: 'select 2', from: 19, to: 27 },
    ])
  })

  test('a line comment ends at CRLF', () => {
    expect(splitStatements('select 1 -- a; b\r\n; select 2')).toEqual([
      { text: 'select 1 -- a; b', from: 0, to: 16 },
      { text: 'select 2', from: 20, to: 28 },
    ])
  })

  test('nested block comments hide their semicolons until the outer one closes', () => {
    expect(splitStatements('/* outer /* nested */ still ; comment */ select 1; select 2')).toEqual([
      { text: 'select 1', from: 41, to: 49 },
      { text: 'select 2', from: 51, to: 59 },
    ])
  })

  test('a comment-only script has no statements', () => {
    expect(splitStatements('-- just a comment\n/* and a block */ ;')).toEqual([])
  })
})

describe('splitStatements: empty statements and whitespace', () => {
  test('empty statements between semicolons are skipped', () => {
    expect(splitStatements(';;  ; select 1 ;;')).toEqual([{ text: 'select 1', from: 6, to: 14 }])
  })

  test('trailing whitespace is trimmed from the statement and from its end offset', () => {
    expect(splitStatements('select 1   \n\t')).toEqual([{ text: 'select 1', from: 0, to: 8 }])
  })

  test('leading whitespace moves the start offset', () => {
    expect(splitStatements('   select 2 ')).toEqual([{ text: 'select 2', from: 3, to: 11 }])
  })

  test('empty input has no statements', () => {
    expect(splitStatements('')).toEqual([])
  })
})

describe('statementAt', () => {
  const sql = 'select 1; select 2'
  const first = { text: 'select 1', from: 0, to: 8 }
  const second = { text: 'select 2', from: 10, to: 18 }

  test.each([
    ['start of the first statement', 0, first],
    ['inside the first statement', 3, first],
    ['on its semicolon', 8, first],
    ['just after its semicolon', 9, first],
    ['start of the second statement', 10, second],
    ['inside the second statement', 14, second],
    ['end of the script', 18, second],
  ])('cursor at %s (%i)', (_label, cursor, expected) => {
    expect(statementAt(sql, cursor)).toEqual(expected)
  })

  test('a cursor in the gap after a semicolon returns the statement before it', () => {
    expect(statementAt('select 1;   select 2', 11)).toEqual({ text: 'select 1', from: 0, to: 8 })
  })

  test('a cursor before the first statement returns the first statement', () => {
    expect(statementAt('  select 1; select 2', 0)).toEqual({ text: 'select 1', from: 2, to: 10 })
  })

  test('empty or blank text has no statement', () => {
    expect(statementAt('', 0)).toBeNull()
    expect(statementAt('   ', 1)).toBeNull()
  })
})
