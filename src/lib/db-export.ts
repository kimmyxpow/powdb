/** Shared by the export dialog (browser) and the export route (server). */

export const EXPORT_CONTENTS = ['all', 'schema', 'data'] as const
export type ExportContent = (typeof EXPORT_CONTENTS)[number]

export const EXPORT_FORMATS = ['sql', 'sql-gz', 'custom'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** The single place that maps a format to its file extension. */
export function exportExtension(format: ExportFormat): 'sql' | 'sql.gz' | 'dump' {
  if (format === 'custom') return 'dump'
  if (format === 'sql-gz') return 'sql.gz'
  return 'sql'
}

const EXPORT_PATH = '/api/export/database'
export const EXPORT_STATUS_PATH = '/api/export/database/status'

export const PG_DUMP_MISSING_MESSAGE =
  'pg_dump is not installed. The PowDB Docker image includes it; when running from source, install the PostgreSQL 18 client.'

/** Answer of GET /api/export/database/status. */
export interface PgDumpStatus {
  available: boolean
  /** pg_dump version such as "18.1", or null when it is missing */
  version: string | null
}

export interface DatabaseExportRequest {
  connection: string
  database: string
  content: ExportContent
  format: ExportFormat
  /** whole schemas; exclusive with `tables` (pg_dump ANDs --schema and --table) */
  schemas?: string[]
  /** individual tables; exclusive with `schemas` */
  tables?: { schema: string; name: string }[]
}

/** The download URL for a request. Lists are comma separated, as the route expects. */
export function databaseExportUrl(req: DatabaseExportRequest): string {
  const params = new URLSearchParams({
    connection: req.connection,
    database: req.database,
    content: req.content,
    format: req.format,
  })
  if (req.schemas?.length) params.set('schemas', req.schemas.join(','))
  if (req.tables?.length) params.set('tables', req.tables.map((t) => `${t.schema}.${t.name}`).join(','))
  return `${EXPORT_PATH}?${params.toString()}`
}
