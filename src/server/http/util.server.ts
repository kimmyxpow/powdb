import type { Infer, Schema } from '@/lib/schema'
import { redactSecrets } from '@/lib/redact'
import { RateLimitError, SESSION_COOKIE } from '@/server/auth.server'
import { MANAGED_ERROR } from '@/server/store.server'

/**
 * Shared HTTP helpers for the REST, auth and MCP handlers: JSON and error responses,
 * body parsing, cookies and the same-origin check. Plain Request in, Response out.
 */

/** An error with an HTTP status. Thrown anywhere in a handler, turned into a response once. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, 'invalid_request', message)
}

/** A required 0 or 1 query flag. */
export function flagParam(params: URLSearchParams, name: string): boolean {
  const value = params.get(name)
  if (value !== '0' && value !== '1') throw badRequest(`${name} must be 0 or 1.`)
  return value === '1'
}

/** A size limit in megabytes from an environment variable, or the fallback when it is unset or not a positive number. */
export function envMegabytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function fileTooLarge(limitMb: number, envName: string): HttpError {
  return new HttpError(413, 'too_large', `The file is larger than ${limitMb} MB. Set ${envName} to allow more.`)
}

/** Refuses an upload whose Content-Length is over the limit, before anything is read. */
export function checkDeclaredSize(request: Request, limitMb: number, envName: string): void {
  const header = request.headers.get('content-length')
  if (header === null) return
  const declared = Number(header)
  if (Number.isFinite(declared) && declared > limitMb * 1024 * 1024) throw fileTooLarge(limitMb, envName)
}

/**
 * A JSON body with an explicit Content-Length. Bun only adds that header when it sends the bytes, so
 * without it server.ts cannot tell a small response from a large one before deciding to compress.
 */
function jsonBody(text: string, status: number, headers: Record<string, string>): Response {
  const bytes = new TextEncoder().encode(text)
  return new Response(bytes, {
    status,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Content-Length': String(bytes.byteLength),
      ...headers,
    },
  })
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return jsonBody(JSON.stringify(data), status, headers)
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonBody(JSON.stringify({ error: { code, message } }), status, headers)
}

/** Maps anything thrown by a handler to the error shape in the spec. Unknown errors are 500s. */
export function errorToResponse(err: unknown): Response {
  if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, err.headers)
  if (err instanceof RateLimitError) {
    return errorResponse(429, 'rate_limited', err.message, { 'Retry-After': String(err.retryAfterSec) })
  }
  const message = err instanceof Error ? err.message : 'Unexpected error.'
  if (message === MANAGED_ERROR) return errorResponse(409, 'managed', MANAGED_ERROR)
  console.error('[powview] request failed:', redactSecrets(message))
  // the message stays useful (e.g. a PostgreSQL error), but never carries a password or token
  return errorResponse(500, 'internal', redactSecrets(message))
}

/** Largest body the JSON and MCP routes read. The file routes (CSV import, restore) have their own limits. */
export const MAX_BODY_BYTES = 1024 * 1024

function bodyTooLarge(): HttpError {
  return new HttpError(400, 'body_too_large', 'The request body is larger than 1 MB.')
}

/**
 * The raw request body as text, capped at 1 MB. A Content-Length over the cap is refused before
 * anything is read. Otherwise reading stops as soon as the cap is passed.
 */
export async function readText(request: Request): Promise<string> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw bodyTooLarge()
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let finished = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_BODY_BYTES) throw bodyTooLarge()
      chunks.push(next.value)
    }
    finished = true
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  // TextDecoder drops a leading UTF-8 byte order mark, as Request.text() does.
  return new TextDecoder().decode(bytes)
}

/** The request body as JSON. An empty body is an empty object. */
async function readBody(request: Request): Promise<unknown> {
  const text = await readText(request)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.')
  }
}

/** Reads the body and validates it with the schema. The first problem is reported as a 400. */
export async function parseBody<S extends Schema<unknown, unknown>>(request: Request, schema: S): Promise<Infer<S>> {
  const parsed = schema.safeParse(await readBody(request))
  if (parsed.success) return parsed.data as Infer<S>
  const issue = parsed.error.issues[0]
  if (!issue) throw new HttpError(400, 'invalid_request', 'The request is not valid.')
  const where = issue.path.map(String).join('.')
  throw new HttpError(400, 'invalid_request', where ? `${where}: ${issue.message}` : issue.message)
}

/** A query string value, or undefined when it is missing or empty. */
export function queryParam(request: Request, name: string): string | undefined {
  const value = new URL(request.url).searchParams.get(name)
  return value === null || value.trim() === '' ? undefined : value.trim()
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

/** POWVIEW_SECURE_COOKIES: true and false are forced; auto means Secure when the request is https. */
function secureCookies(request: Request): boolean {
  const setting = (process.env.POWVIEW_SECURE_COOKIES ?? 'auto').trim().toLowerCase()
  if (setting === 'true') return true
  if (setting === 'false') return false
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  return forwarded === 'https' || new URL(request.url).protocol === 'https:'
}

/** The session cookie. A token with maxAgeSec 0 clears it (logout). */
export function sessionCookieHeader(request: Request, token: string, maxAgeSec: number): string {
  const secure = secureCookies(request) ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

/** An Origin header, when sent, must name the same host as Host (403 otherwise). */
export function guardOrigin(request: Request): void {
  const origin = request.headers.get('origin')
  if (origin === null) return
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase()
  if (originHost(origin) !== host) {
    throw new HttpError(403, 'cross_origin', 'Requests from another site are not allowed.')
  }
}

/**
 * Checks for state-changing requests. An Origin header must name the same host as Host
 * (403 otherwise). Requests that carry the session cookie must also send JSON, which a
 * cross-site form cannot do.
 */
export function guardMutation(request: Request): void {
  if (!MUTATING_METHODS.has(request.method)) return
  guardOrigin(request)
  if (readCookie(request, SESSION_COOKIE) !== null) {
    const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (type !== 'application/json') {
      throw new HttpError(400, 'content_type', 'Send this request with Content-Type: application/json.')
    }
  }
}

/** POWVIEW_TRUST_PROXY=true: the server sits behind a reverse proxy that sets X-Forwarded-For. */
function trustProxy(): boolean {
  return (process.env.POWVIEW_TRUST_PROXY ?? '').trim().toLowerCase() === 'true'
}

/**
 * The client address for the login rate limit. With POWVIEW_TRUST_PROXY=true, the first address
 * in X-Forwarded-For wins (then X-Real-IP). Otherwise, or when the headers are missing, the
 * socket address is used. Without a socket address the result is 'unknown'.
 */
export function clientIpFrom(request: Request, socketAddress: string | undefined): string {
  if (trustProxy()) {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
    const realIp = request.headers.get('x-real-ip')?.trim()
    if (realIp) return realIp
  }
  return socketAddress || 'unknown'
}

/** The client's address for this request. Used only for the login rate limit. */
export async function clientIp(request: Request): Promise<string> {
  // xForwardedFor is off: the header is read only when POWVIEW_TRUST_PROXY allows it.
  const { getRequestIP } = await import('@tanstack/react-start/server')
  return clientIpFrom(request, getRequestIP({ xForwardedFor: false }) ?? undefined)
}
