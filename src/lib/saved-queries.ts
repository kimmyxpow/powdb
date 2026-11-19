import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createSavedQueryFn,
  deleteSavedQueryFn,
  listSavedQueriesFn,
  updateSavedQueryFn,
} from '@/api/saved-queries.functions'

/** Every saved-queries key starts with this, so one invalidation refreshes all connections. */
const ROOT = 'saved-queries' as const

export const savedQueriesQuery = (connectionId: string) =>
  queryOptions({
    queryKey: [ROOT, connectionId] as const,
    queryFn: () => listSavedQueriesFn({ data: { connectionId } }),
    staleTime: 30_000,
  })

function useInvalidateSaved() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [ROOT] })
}

export function useCreateSavedQuery() {
  const invalidate = useInvalidateSaved()
  return useMutation({
    mutationFn: (input: { name: string; sql: string; connectionId: string | null; database: string | null }) =>
      createSavedQueryFn({ data: input }),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateSavedQuery() {
  const invalidate = useInvalidateSaved()
  return useMutation({
    mutationFn: (input: {
      id: string
      patch: { name?: string; sql?: string; connectionId?: string | null; database?: string | null }
    }) => updateSavedQueryFn({ data: input }),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteSavedQuery() {
  const invalidate = useInvalidateSaved()
  return useMutation({
    mutationFn: (id: string) => deleteSavedQueryFn({ data: { id } }),
    onSuccess: () => invalidate(),
  })
}

/** Name suggested for a new saved query: the first 40 characters of the first line that is not a comment. */
export function suggestSavedName(sql: string): string {
  const line = sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('--') && !l.startsWith('/*'))
  return line?.slice(0, 40).trim() || 'Untitled query'
}

/** First non-empty line of the SQL, for previews. */
export function firstLine(sql: string): string {
  return (
    sql
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  )
}
