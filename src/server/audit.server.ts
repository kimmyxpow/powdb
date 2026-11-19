import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AuditEntry } from '@/lib/types'
import { dataDir } from './store.server'

/**
 * One JSON line per agent query in $POWVIEW_DATA_DIR/audit.jsonl (mode 0600). When the file
 * reaches 5 MB it is moved to audit.1.jsonl, which replaces the previous rotation.
 */
const MAX_BYTES = 5 * 1024 * 1024
const MAX_SQL = 5000

// Writes go through one queue so a rotation never races an append.
let chain: Promise<void> = Promise.resolve()

function files(): { current: string; rotated: string } {
  const dir = dataDir()
  return { current: path.join(dir, 'audit.jsonl'), rotated: path.join(dir, 'audit.1.jsonl') }
}

/** Never throws: a failed audit write is logged, and must not fail the query it describes. */
export async function appendAudit(entry: AuditEntry): Promise<void> {
  try {
    const line = JSON.stringify({ ...entry, sql: entry.sql.slice(0, MAX_SQL) }) + '\n'
    const run = chain.then(() => writeLine(line))
    chain = run.catch(() => {})
    await run
  } catch (err) {
    console.warn(`[powview] audit log write failed: ${(err as Error).message}`)
  }
}

async function writeLine(line: string): Promise<void> {
  const { current, rotated } = files()
  await mkdir(dataDir(), { recursive: true, mode: 0o700 })
  try {
    if ((await stat(current)).size >= MAX_BYTES) await rename(current, rotated)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await appendFile(current, line, { mode: 0o600 })
}

/** Newest first. Lines that do not parse are skipped. */
export async function readAudit(limit: number): Promise<AuditEntry[]> {
  const { current, rotated } = files()
  const lines = [...(await readLines(rotated)), ...(await readLines(current))]
  const out: AuditEntry[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]!) as AuditEntry)
    } catch {
      // a torn or hand-edited line: skip it rather than fail the whole listing
    }
  }
  return out
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await Bun.file(file).text()).split('\n').filter(Boolean)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
