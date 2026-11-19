/** Shared by the restore dialog (browser), the restore route (server) and the CLI. */

export const RESTORE_FORMATS = ['sql', 'sql-gz', 'custom'] as const
export type RestoreFormat = (typeof RESTORE_FORMATS)[number]

const RESTORE_PATH = '/api/import/restore'

/** Name of each format as the UI and the messages show it. */
export const RESTORE_FORMAT_LABELS: Record<RestoreFormat, string> = {
  sql: 'SQL',
  'sql-gz': 'Compressed SQL',
  custom: 'pg_dump custom',
}

/** The first bytes needed to tell the formats apart. */
export const RESTORE_SNIFF_BYTES = 5

const PGDMP = [0x50, 0x47, 0x44, 0x4d, 0x50]
const GZIP = [0x1f, 0x8b]

function startsWith(head: Uint8Array, magic: number[]): boolean {
  return head.length >= magic.length && magic.every((byte, i) => head[i] === byte)
}

/** The format the first bytes of a file belong to. Anything without a known magic number is plain SQL. */
export function detectRestoreFormat(head: Uint8Array): RestoreFormat {
  if (startsWith(head, PGDMP)) return 'custom'
  if (startsWith(head, GZIP)) return 'sql-gz'
  return 'sql'
}

/** null when the file's first bytes match the expected format, else the message the server sends. */
export function restoreFormatMismatch(head: Uint8Array, expected: RestoreFormat): string | null {
  const found = detectRestoreFormat(head)
  if (found === expected) return null
  return `The file looks like ${RESTORE_FORMAT_LABELS[found]}, not ${RESTORE_FORMAT_LABELS[expected]}.`
}

export interface RestoreRequest {
  connection: string
  database: string
  format: RestoreFormat
  atomic: boolean
  clean: boolean
}

/** The POST URL for a restore. The file itself is the request body. */
export function restoreUrl(req: RestoreRequest): string {
  const params = new URLSearchParams({
    connection: req.connection,
    database: req.database,
    format: req.format,
    atomic: req.atomic ? '1' : '0',
    clean: req.clean ? '1' : '0',
  })
  return `${RESTORE_PATH}?${params.toString()}`
}

/** The body of a restore response. A 422 adds `error: { code, message }`. */
export interface RestoreResult {
  /** true when the tool exited with 0 (errors may still be counted when not all or nothing) */
  ok: boolean
  exitCode: number
  errors: number
  /** the last lines of the tool's stderr, '' when there is none */
  log: string
}
