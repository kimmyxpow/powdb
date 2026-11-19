import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { listActivityFn, listAuditFn } from '@/api/activity.functions'
import { keys } from './queries'

/** The AI access audit log, newest first. */
export const auditQuery = (limit: number) =>
  queryOptions({
    queryKey: ['audit', limit] as const,
    queryFn: () => listAuditFn({ data: { limit } }),
  })

export const activityQuery = (connectionId: string, database: string, allDatabases: boolean) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'activity', allDatabases],
    queryFn: () => listActivityFn({ data: { connectionId, database, allDatabases } }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: false,
  })
