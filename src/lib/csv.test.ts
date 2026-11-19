import { describe, expect, test } from 'bun:test'
import { CsvStream, detectDelimiter, parseCsv } from './csv'

/** Feed the text in pieces of the given size and collect every record. */
function streamed(text: string, size: number, delimiter = ','): string[][] {
  const stream = new CsvStream(delimiter)
  const out: string[][] = []
  for (let i = 0; i < text.length; i += size) out.push(...stream.push(text.slice(i, i + size)))
  out.push(...stream.end())
  return out
}

describe('parseCsv', () => {
  test('plain fields and rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  test('quoted fields keep delimiters and quotes', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']])
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', 'x']])
    expect(parseCsv('""""')).toEqual([['"']])
  })

  test('embedded newlines inside quotes', () => {
    expect(parseCsv('"line 1\nline 2",x\ny,z')).toEqual([
      ['line 1\nline 2', 'x'],
      ['y', 'z'],
    ])
    expect(parseCsv('"a\r\nb",c')).toEqual([['a\r\nb', 'c']])
  })

  test('CRLF and lone CR are line breaks', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(parseCsv('a\rb')).toEqual([['a'], ['b']])
  })

  test('trailing newline does not add a record, and a missing one is fine', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']])
    expect(parseCsv('a,b')).toEqual([['a', 'b']])
    expect(parseCsv('')).toEqual([])
  })

  test('empty lines are skipped, empty fields are kept', () => {
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], ['b']])
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']])
    expect(parseCsv(',')).toEqual([['', '']])
    expect(parseCsv('""\n')).toEqual([['']])
  })

  test('a BOM at the start is dropped', () => {
    expect(parseCsv('﻿id,name\n1,a')).toEqual([
      ['id', 'name'],
      ['1', 'a'],
    ])
  })

  test('a stray quote inside an unquoted field is kept', () => {
    expect(parseCsv('5" screen,x')).toEqual([['5" screen', 'x']])
  })

  test('custom delimiters', () => {
    expect(parseCsv('a;b\n"c;d";e', ';')).toEqual([
      ['a', 'b'],
      ['c;d', 'e'],
    ])
    expect(parseCsv('a\tb', '\t')).toEqual([['a', 'b']])
    expect(parseCsv('a|b', '|')).toEqual([['a', 'b']])
  })

  test('an unterminated quote runs to the end of the input', () => {
    expect(parseCsv('"abc\ndef')).toEqual([['abc\ndef']])
  })
})

describe('CsvStream across chunk boundaries', () => {
  const samples: [string, string[][]][] = [
    [
      'id,name\r\n1,"Ann ""A"""\r\n2,"multi\r\nline"\r\n',
      [
        ['id', 'name'],
        ['1', 'Ann "A"'],
        ['2', 'multi\r\nline'],
      ],
    ],
    ['a,"b,c",d\n\n"x""y"\n', [['a', 'b,c', 'd'], ['x"y']]],
    [
      '﻿a,b\rc,d',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
  ]

  test('every chunk size gives the same records as parseCsv', () => {
    for (const [text] of samples) {
      const expected = parseCsv(text)
      for (let size = 1; size <= text.length + 1; size++) {
        expect(streamed(text, size)).toEqual(expected)
      }
    }
  })

  test('a quoted field split between two chunks', () => {
    const stream = new CsvStream()
    expect(stream.push('"ab')).toEqual([])
    expect(stream.push('c",d\n')).toEqual([['abc', 'd']])
  })

  test('an escaped quote split between two chunks', () => {
    const stream = new CsvStream()
    expect(stream.push('"a"')).toEqual([])
    expect(stream.push('"b"\n')).toEqual([['a"b']])
  })

  test('a CRLF split between two chunks is one line break', () => {
    const stream = new CsvStream()
    expect(stream.push('a,b\r')).toEqual([['a', 'b']])
    expect(stream.push('\nc,d\r\n')).toEqual([['c', 'd']])
    expect(stream.lastLines).toEqual([2])
  })

  test('the closing quote at the end of a chunk followed by a CRLF in the next', () => {
    const stream = new CsvStream()
    expect(stream.push('"x"')).toEqual([])
    expect(stream.push('\r\ny')).toEqual([['x']])
    expect(stream.end()).toEqual([['y']])
  })
})

describe('CsvStream line numbers', () => {
  test('lastLines gives the physical line where each record starts', () => {
    const stream = new CsvStream()
    const rows = [...stream.push('h1,h2\n"multi\nline",x\n\ny,z\n'), ...stream.end()]
    expect(rows).toEqual([
      ['h1', 'h2'],
      ['multi\nline', 'x'],
      ['y', 'z'],
    ])
    const again = new CsvStream()
    expect(again.push('h1,h2\n"multi\nline",x\n\ny,z\n')).toEqual(rows)
    expect(again.lastLines).toEqual([1, 2, 5])
  })

  test('record lines are reported per call', () => {
    const stream = new CsvStream()
    stream.push('a\nb\n')
    expect(stream.lastLines).toEqual([1, 2])
    stream.push('c\n')
    expect(stream.lastLines).toEqual([3])
  })
})

describe('detectDelimiter', () => {
  test('picks the most frequent candidate on the first line', () => {
    expect(detectDelimiter('a,b,c\n1;2;3')).toBe(',')
    expect(detectDelimiter('a;b;c\n')).toBe(';')
    expect(detectDelimiter('a\tb\tc\td\n')).toBe('\t')
    expect(detectDelimiter('a|b|c')).toBe('|')
  })

  test('ignores candidates inside quotes', () => {
    expect(detectDelimiter('"a,b,c,d";e;f')).toBe(';')
    expect(detectDelimiter('"x;y;z"|"p;q"|r')).toBe('|')
  })

  test('only the first line counts', () => {
    expect(detectDelimiter('a;b\nc,d,e,f,g')).toBe(';')
  })

  test('ties go to the earlier candidate, and no candidate means comma', () => {
    expect(detectDelimiter('a,b;c')).toBe(',')
    expect(detectDelimiter('single column')).toBe(',')
    expect(detectDelimiter('')).toBe(',')
  })

  test('a BOM does not affect detection', () => {
    expect(detectDelimiter('﻿a;b;c')).toBe(';')
  })
})
