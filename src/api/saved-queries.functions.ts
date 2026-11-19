import { createServerFn } from '@tanstack/react-start'
import type { SavedQuery } from '@/lib/types'
import { savedQueryValidators } from './validators'

export const listSavedQueriesFn = createServerFn({ method: 'GET' })
  .validator(savedQueryValidators().listSavedQueries)
  .handler(async ({ data }): Promise<SavedQuery[]> => {
    const { listSavedQueries } = await import('@/server/saved-queries.server')
    return listSavedQueries(data.connectionId)
  })

export const createSavedQueryFn = createServerFn({ method: 'POST' })
  .validator(savedQueryValidators().createSavedQuery)
  .handler(async ({ data }): Promise<SavedQuery> => {
    const { createSavedQuery } = await import('@/server/saved-queries.server')
    return createSavedQuery(data)
  })

export const updateSavedQueryFn = createServerFn({ method: 'POST' })
  .validator(savedQueryValidators().updateSavedQuery)
  .handler(async ({ data }): Promise<SavedQuery> => {
    const { updateSavedQuery } = await import('@/server/saved-queries.server')
    return updateSavedQuery(data.id, data.patch)
  })

export const deleteSavedQueryFn = createServerFn({ method: 'POST' })
  .validator(savedQueryValidators().deleteSavedQuery)
  .handler(async ({ data }) => {
    const { deleteSavedQuery } = await import('@/server/saved-queries.server')
    await deleteSavedQuery(data.id)
    return { ok: true }
  })
