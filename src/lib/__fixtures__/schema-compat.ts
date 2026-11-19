// Loads schema-compat.json, the record of what zod 4 did for PowDB's schemas (see schema.test.ts
// and mcp.test.ts). Test-only: nothing in the app imports this file.
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface FixtureIssue {
  code: string
  path: (string | number)[]
  message: string
}

export interface FixtureCase {
  input: unknown
  ok: boolean
  value?: unknown
  issues?: FixtureIssue[]
}

export interface Fixture {
  schemas: Record<string, { json: unknown; cases: FixtureCase[] }>
  mcpTools: Record<string, { inputSchema: unknown }>
  mcpCalls: Record<string, Array<{ input: unknown; ok: boolean; error?: { code: number; message: string } }>>
  configCases: Array<{ name: string; file: string; text: string; ok: boolean; value?: unknown; error?: string }>
  importCases: Array<{ query: string; ok: boolean; value?: unknown; error?: string }>
  exportCases: Array<{ query: string; ok: boolean; value?: unknown; error?: string }>
}

export const FIXTURE_PATH = path.join(import.meta.dir, 'schema-compat.json')

export const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture

/** Undoes the fixture's encoding of undefined and non-finite numbers. */
export function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('$undefined' in obj) return undefined
    if ('$number' in obj) return Number(obj.$number)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      Object.defineProperty(out, key, { value: revive(obj[key]), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  return value
}
