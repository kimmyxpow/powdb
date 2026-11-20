import { createServerFn } from '@tanstack/react-start'
import type { SavedView } from '@/lib/types'
import { savedViewValidators } from './validators'

export const listSavedViewsFn = createServerFn({ method: 'GET' })
  .validator(savedViewValidators().listSavedViews)
  .handler(async ({ data }): Promise<SavedView[]> => {
    const { listSavedViews } = await import('@/server/saved-views.server')
    return listSavedViews(data)
  })

export const listSavedViewsForDatabaseFn = createServerFn({ method: 'GET' })
  .validator(savedViewValidators().listSavedViewsForDatabase)
  .handler(async ({ data }): Promise<SavedView[]> => {
    const { listSavedViewsForDatabase } = await import('@/server/saved-views.server')
    return listSavedViewsForDatabase(data)
  })

export const createSavedViewFn = createServerFn({ method: 'POST' })
  .validator(savedViewValidators().createSavedView)
  .handler(async ({ data }): Promise<SavedView> => {
    const { createSavedView } = await import('@/server/saved-views.server')
    return createSavedView(data)
  })

export const updateSavedViewFn = createServerFn({ method: 'POST' })
  .validator(savedViewValidators().updateSavedView)
  .handler(async ({ data }): Promise<SavedView> => {
    const { updateSavedView } = await import('@/server/saved-views.server')
    return updateSavedView(data.id, data.patch)
  })

export const deleteSavedViewFn = createServerFn({ method: 'POST' })
  .validator(savedViewValidators().deleteSavedView)
  .handler(async ({ data }) => {
    const { deleteSavedView } = await import('@/server/saved-views.server')
    await deleteSavedView(data.id)
    return { ok: true }
  })
