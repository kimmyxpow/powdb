import { createServerFn } from '@tanstack/react-start'
import type { AuditEntry } from '@/lib/types'
import type { ActivityRow } from '@/server/activity.server'
import { activityValidators } from './validators'

/** The newest entries of the AI access audit log (the signed-in admin's view). */
export const listAuditFn = createServerFn({ method: 'GET' })
  .validator(activityValidators().listAudit)
  .handler(async ({ data }): Promise<AuditEntry[]> => {
    const { readAudit } = await import('@/server/audit.server')
    const { withClientErrors } = await import('@/lib/redact')
    return withClientErrors(() => readAudit(data.limit), 'Could not load the activity log.')
  })

export const listActivityFn = createServerFn({ method: 'GET' })
  .validator(activityValidators().listActivity)
  .handler(async ({ data }): Promise<ActivityRow[]> => {
    const { listActivity } = await import('@/server/activity.server')
    return listActivity(data.connectionId, data.database, { allDatabases: data.allDatabases })
  })

export const signalBackendFn = createServerFn({ method: 'POST' })
  .validator(activityValidators().signalBackend)
  .handler(async ({ data }): Promise<void> => {
    const { signalBackend } = await import('@/server/activity.server')
    return signalBackend(data.connectionId, data.database, data.pid, data.action)
  })
