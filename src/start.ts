import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { isPublicServerFn } from '@/api/public-functions'
import { needsSignIn } from '@/api/session-gate'

// Server functions can run arbitrary SQL, so only accept same-origin calls.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
})

// Every server function needs a signed-in session when auth is on, except those listed in
// src/api/public-functions.ts. The exemption is matched by the function's name and file (serverFnMeta),
// never by path or header. A call without a known identity needs a session.
const authMiddleware = createMiddleware({ type: 'function' }).server(async ({ next, serverFnMeta }) => {
  if (isPublicServerFn(serverFnMeta)) return next()
  const { getRequest } = await import('@tanstack/react-start/server')
  const { SESSION_COOKIE, authEnabled, verifySession } = await import('@/server/auth.server')
  const { readCookie } = await import('@/server/http/util.server')
  const enabled = authEnabled()
  const sessionValid = enabled && (await verifySession(readCookie(getRequest(), SESSION_COOKIE)))
  if (needsSignIn({ isPublic: false, authEnabled: enabled, sessionValid })) {
    throw new Error('UNAUTHENTICATED')
  }
  return next()
})

// The explorer is a highly interactive client app: render pages in the browser
// and use server functions for everything that talks to PostgreSQL.
export const startInstance = createStart(() => ({
  defaultSsr: false,
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [authMiddleware],
}))
