/**
 * Production server for PowDB (run `bun run build` first, then `bun run start`).
 *
 * - Serves the built client assets from memory (dist/client, read once at startup)
 * - Forwards everything else to the TanStack Start handler
 * - Binds to 127.0.0.1 by default and rejects unknown Host headers, because the
 *   app can run arbitrary SQL with your saved credentials. Expose it on a network
 *   only behind your own authentication.
 *
 * Env: PORT (3333), HOST (127.0.0.1), POWDB_ALLOWED_HOSTS (comma separated),
 *      POWDB_DATA_DIR (./.data), POWDB_MAX_IMPORT_MB (200), POWDB_MAX_RESTORE_MB (2048)
 */
/// <reference types="bun" />
import path from 'node:path'
import { acceptsEncoding, isSmallBody, shouldCompress } from '#/lib/compression'
import { IDLE_TIMEOUT_SECONDS, isLongRunningPath, requestBodyLimitBytes } from '#/lib/server-options'
import {
  assetKey,
  decodeRequestPath,
  isStaticRequestPath,
  loadAssetTable,
  notFoundResponse,
  serveAsset,
} from '#/lib/static-assets'
import { parsePort } from '#/lib/port'

const port = parsePort(process.env.PORT)
if (port === null) {
  console.error(`[powdb] PORT must be a whole number from 1 to 65535, not "${process.env.PORT}". Fix it or unset it.`)
  process.exit(1)
}
const hostname = process.env.HOST ?? '127.0.0.1'
const clientDir = path.join(import.meta.dir, 'dist', 'client')

const allowedHosts = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  ...(process.env.POWDB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
])
if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '0.0.0.0') {
  allowedHosts.add(hostname.toLowerCase())
}

// built by `bun run build` (path kept in a variable so type-checking does not require the build)
const serverEntry = './dist/server/server.js'
const { default: app } = (await import(serverEntry)) as {
  default: { fetch: (request: Request) => Response | Promise<Response> }
}

// Held in memory for the life of the process.
const assets = await loadAssetTable(clientDir)

function hostAllowed(request: Request): boolean {
  const host = (request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '')
  return allowedHosts.has(host)
}

function forbidden(): Response {
  return new Response('Forbidden: unknown host. Add it to POWDB_ALLOWED_HOSTS.', { status: 403 })
}

/** Gzips a dynamic response when the client accepts it, the type is text-like and the body is not small. */
function compressResponse(request: Request, response: Response): Response {
  if (!response.body || response.status === 204 || response.status === 304) return response
  if (response.headers.has('content-encoding')) return response
  if (!acceptsEncoding(request.headers.get('accept-encoding'), 'gzip')) return response
  if (!shouldCompress(response.headers.get('content-type'))) return response
  if (isSmallBody(response.headers.get('content-length'))) return response
  const headers = new Headers(response.headers)
  headers.set('Content-Encoding', 'gzip')
  headers.append('Vary', 'Accept-Encoding')
  headers.delete('Content-Length')
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function forward(request: Request): Promise<Response> {
  return compressResponse(request, await app.fetch(request))
}

/**
 * Requests that no exact asset route took: asset paths that need decoding, static paths that are
 * not in the table (fast 404), and everything else for the app.
 */
async function handle(request: Request): Promise<Response> {
  if (!hostAllowed(request)) return forbidden()
  const url = new URL(request.url)
  if (isLongRunningPath(url.pathname)) server.timeout(request, 0)
  if (request.method === 'GET' || request.method === 'HEAD') {
    const decoded = decodeRequestPath(url.pathname)
    if (decoded !== null) {
      const key = assetKey(decoded)
      const asset = key === null ? undefined : assets.get(key)
      if (asset) return serveAsset(request, asset)
      if (isStaticRequestPath(decoded)) return notFoundResponse()
    }
  }
  return forward(request)
}

// One exact route per client file: Bun matches these before fetch, which is the fastest path for
// the assets the browser asks for. Route patterns treat ":" "*" "{" "}" as syntax, so names with
// those characters are left to handle(), which finds them in the table too.
const routes: Record<string, (request: Request) => Response | Promise<Response>> = {}
for (const [key, asset] of assets) {
  const routePath = `/${key}`
  if (/[:*{}]/.test(routePath)) continue
  routes[routePath] = (request) => {
    if (!hostAllowed(request)) return forbidden()
    if (request.method === 'GET' || request.method === 'HEAD') return serveAsset(request, asset)
    return forward(request)
  }
}

const server = Bun.serve({
  port,
  hostname,
  development: false,
  idleTimeout: IDLE_TIMEOUT_SECONDS,
  maxRequestBodySize: requestBodyLimitBytes(process.env),
  routes,
  fetch: handle,
})

console.log(`PowDB running at http://${server.hostname}:${server.port}`)
