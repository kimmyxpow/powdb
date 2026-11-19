import { createServerFn } from '@tanstack/react-start'
import type { ApiTokenInfo } from '@/lib/types'
import { tokenValidators } from './validators'

// All need a session (src/start.ts).

export const listTokensFn = createServerFn({ method: 'GET' }).handler(async (): Promise<ApiTokenInfo[]> => {
  const { listApiTokens } = await import('@/server/auth.server')
  const { withClientErrors } = await import('@/lib/redact')
  return withClientErrors(() => listApiTokens(), 'Could not load the tokens.')
})

/** The token value is returned once, here. It is never stored, only its SHA-256. */
export const createTokenFn = createServerFn({ method: 'POST' })
  .validator(tokenValidators().createToken)
  .handler(async ({ data }): Promise<{ token: string; info: ApiTokenInfo }> => {
    const { createApiToken } = await import('@/server/auth.server')
    const { tokenConnectionIds } = await import('@/server/http/core.server')
    const { withClientErrors } = await import('@/lib/redact')
    return withClientErrors(
      async () =>
        createApiToken({
          name: data.name,
          scope: data.scope,
          connections: await tokenConnectionIds(data.connections),
          expiresInDays: data.expiresInDays,
        }),
      'Could not create the token.',
    )
  })

export const revokeTokenFn = createServerFn({ method: 'POST' })
  .validator(tokenValidators().revokeToken)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { revokeApiToken } = await import('@/server/auth.server')
    const { withClientErrors } = await import('@/lib/redact')
    await withClientErrors(() => revokeApiToken(data.id), 'Could not revoke the token.')
    return { ok: true }
  })
