// CSV parsing shared by the browser (preview) and the server (import).
// RFC 4180 with lenient edges: a quote only opens a field at its start, a stray quote
// inside an unquoted field is kept, and a quoted field may run over several lines.
// The parser is a character state machine, so its state survives chunk boundaries
// (a quoted field, an escaped quote or a CRLF may be split between two chunks).

const CSV_DELIMITERS = [',', ';', '\t', '|'] as const

const BOM = '﻿'

/**
 * Streaming parser. Feed text with `push`, then call `end` once. Both return the records
 * completed by that call. `lastLines[i]` is the 1-based physical line on which record `i`
 * of the last call starts (quoted fields can make a record span several lines). Lines that
 * are completely empty are skipped.
 */
export class CsvStream {
  readonly delimiter: string
  /** start line of each record returned by the most recent push or end call */
  lastLines: number[] = []

  private row: string[] = []
  private field = ''
  private fieldStart = true
  private inQuotes = false
  /** inside a quoted field, the previous character was a quote (an escape or the closing quote) */
  private quoteSeen = false
  private recordChars = false
  private recordLine = 1
  private line = 1
  private prevCR = false
  private started = false

  /** a run of characters that the state machine handles one by one only at the stop characters */
  private readonly run: RegExp

  constructor(delimiter = ',') {
    this.delimiter = delimiter
    const stop = delimiter.replace(/[\\\]^-]/g, '\\$&')
    this.run = new RegExp(`[^${stop}"\\r\\n]+`, 'y')
  }

  push(chunk: string): string[][] {
    const out: string[][] = []
    this.lastLines = []
    let i = 0
    while (i < chunk.length) {
      // plain characters are appended in one step; the rest goes through consume
      if (this.started && !this.quoteSeen) {
        this.run.lastIndex = i
        const m = this.run.exec(chunk)
        if (m) {
          this.appendRun(m[0])
          i += m[0].length
          continue
        }
      }
      this.consume(chunk[i]!, out)
      i++
    }
    return out
  }

  /** Appends characters that are neither a delimiter, a quote nor a line break (see consume). */
  private appendRun(text: string): void {
    this.prevCR = false
    if (!this.recordChars) {
      this.recordChars = true
      this.recordLine = this.line
    }
    this.field += text
    this.fieldStart = false
  }

  end(): string[][] {
    const out: string[][] = []
    this.lastLines = []
    this.inQuotes = false
    this.quoteSeen = false
    if (this.recordChars) this.endRecord(out)
    return out
  }

  private consume(ch: string, out: string[][]): void {
    if (!this.started) {
      this.started = true
      if (ch === BOM) return
    }
    const prevCR = this.prevCR
    this.prevCR = ch === '\r'
    const isBreak = ch === '\n' || ch === '\r'
    // a CRLF is one line break; a lone CR or LF is one too
    if (isBreak && !(ch === '\n' && prevCR)) this.line++

    if (this.inQuotes) {
      if (this.quoteSeen) {
        this.quoteSeen = false
        if (ch === '"') {
          this.field += '"'
          return
        }
        // the quote closed the field; this character is handled below as unquoted
        this.inQuotes = false
      } else {
        if (ch === '"') this.quoteSeen = true
        else this.field += ch
        return
      }
    }

    // an unquoted line break: the second half of a CRLF is ignored
    if (ch === '\n' && prevCR) return
    if (ch === '\r' || ch === '\n') {
      this.endRecord(out)
      return
    }

    if (!this.recordChars) {
      this.recordChars = true
      this.recordLine = this.line
    }

    if (ch === this.delimiter) {
      this.row.push(this.field)
      this.field = ''
      this.fieldStart = true
      return
    }
    if (ch === '"' && this.fieldStart) {
      this.inQuotes = true
      this.fieldStart = false
      return
    }
    this.field += ch
    this.fieldStart = false
  }

  private endRecord(out: string[][]): void {
    if (this.recordChars) {
      this.row.push(this.field)
      out.push(this.row)
      this.lastLines.push(this.recordLine)
    }
    this.row = []
    this.field = ''
    this.fieldStart = true
    this.recordChars = false
  }
}

/** All records of a complete text. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const stream = new CsvStream(delimiter)
  return [...stream.push(text), ...stream.end()]
}

/**
 * The delimiter used by the first line: the candidate that occurs most often outside
 * quotes. Ties go to the earlier candidate (comma first). Falls back to a comma.
 */
export function detectDelimiter(sample: string): string {
  const counts = new Map<string, number>(CSV_DELIMITERS.map((d) => [d, 0]))
  let inQuotes = false
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i]!
    if (i === 0 && ch === BOM) continue
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (inQuotes) continue
    if (ch === '\n' || ch === '\r') break
    const count = counts.get(ch)
    if (count !== undefined) counts.set(ch, count + 1)
  }
  let best: string = ','
  let bestCount = 0
  for (const d of CSV_DELIMITERS) {
    const count = counts.get(d) ?? 0
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}
