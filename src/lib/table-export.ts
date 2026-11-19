/** Formats for the whole-table export. Shared by the export route (server) and the admin CLI. */

export const TABLE_EXPORT_FORMATS = ['csv', 'json', 'ndjson', 'sql'] as const
export type TableExportFormat = (typeof TABLE_EXPORT_FORMATS)[number]
