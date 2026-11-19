/**
 * Pure settings for the Bun server in server.ts: the request body limit that follows the upload
 * limits, the idle timeout, and which requests opt out of it. Defaults mirror the handlers in
 * src/server/import-csv.server.ts and src/server/restore.server.ts.
 */

/** Bun's idleTimeout is in seconds and cannot exceed 255. Long streams opt out per request. */
export const IDLE_TIMEOUT_SECONDS = 255

/** Mirrors DEFAULT_MAX_IMPORT_MB in import-csv.server.ts (POWDB_MAX_IMPORT_MB). */
export const DEFAULT_MAX_IMPORT_MB = 200

/** Mirrors DEFAULT_MAX_RESTORE_MB in restore.server.ts (POWDB_MAX_RESTORE_MB). */
export const DEFAULT_MAX_RESTORE_MB = 2048

const MEGABYTE = 1024 * 1024

/** A size limit in MB from an environment value. Unset, empty, non-numeric or not positive gives the fallback. */
export function megabytesFrom(raw: string | undefined, fallback: number): number {
  const text = raw?.trim()
  const value = text ? Number(text) : Number.NaN
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Bun's maxRequestBodySize in bytes. It must allow the largest upload either handler accepts, or
 * Bun refuses a restore before the handler runs. Bun's own default is 128 MB.
 */
export function requestBodyLimitBytes(env: Readonly<Record<string, string | undefined>>): number {
  const importMb = megabytesFrom(env.POWDB_MAX_IMPORT_MB, DEFAULT_MAX_IMPORT_MB)
  const restoreMb = megabytesFrom(env.POWDB_MAX_RESTORE_MB, DEFAULT_MAX_RESTORE_MB)
  return Math.ceil(Math.max(importMb, restoreMb) * MEGABYTE)
}

/**
 * Uploads and exports stream for minutes, and a handler can go quiet before its first byte. Bun
 * counts that as idle, so these requests get no idle timeout.
 */
export function isLongRunningPath(pathname: string): boolean {
  return pathname.startsWith('/api/import/') || pathname.startsWith('/api/export/')
}
