import { s } from '@/lib/schema'
import { LOCAL_KEY_HEADER } from '@/server/access.server'
import { SESSION_COOKIE, authState, isLocalKey, resetAdminPassword } from '@/server/auth.server'
import {
  HttpError,
  errorResponse,
  errorToResponse,
  guardMutation,
  jsonResponse,
  parseBody,
  readCookie,
} from './util.server'

/**
 * /api/auth/* for the CLI only: the sign-in state and the local-key password reset.
 * The browser signs in, sets up and changes passwords through server functions (src/api/session.functions.ts
 * and src/api/account.functions.ts), which call the same auth.server functions.
 */

export const passwordReset = s.object({ password: s.string() })

const ROUTES = new Map<string, string>([
  ['state', 'GET'],
  ['reset-password', 'POST'],
])

export async function handleAuthRequest(request: Request, splat: string): Promise<Response> {
  try {
    const name = splat.replace(/^\/+|\/+$/g, '')
    const method = ROUTES.get(name)
    if (!method) return errorResponse(404, 'not_found', 'No such auth endpoint.')
    if (request.method !== method) {
      return errorResponse(405, 'method_not_allowed', `Use ${method} for this endpoint.`, { Allow: method })
    }
    guardMutation(request)
    if (name === 'state') {
      return jsonResponse(await authState(readCookie(request, SESSION_COOKIE)))
    }
    return await resetPassword(request)
  } catch (err) {
    return errorToResponse(err)
  }
}

/** Only the local key (CLI or container) can reset the password without signing in. */
async function resetPassword(request: Request): Promise<Response> {
  const key = request.headers.get(LOCAL_KEY_HEADER)
  if (!key || !(await isLocalKey(key))) {
    throw new HttpError(401, 'unauthenticated', 'The local key is required to reset the password.')
  }
  const { password } = await parseBody(request, passwordReset)
  try {
    await resetAdminPassword(password)
  } catch (err) {
    throw new HttpError(400, 'invalid_input', err instanceof Error ? err.message : 'Reset failed.')
  }
  return jsonResponse({ ok: true })
}
