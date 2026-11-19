import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef } from 'react'
import { create } from '@/lib/create-store'
import { connectionQuery } from '@/lib/queries'

export interface ProductionRequest {
  /** the change in one line, e.g. "Save changes to 3 rows in public.orders" */
  action: string
  detail?: string
  /** the SQL that will run; shown read-only */
  sql?: string
  /** the user must type the database name before the button enables */
  destructive?: boolean
  /** label of the confirm button; default "Run on production" */
  confirmLabel?: string
}

interface ProductionPrompt extends ProductionRequest {
  connectionName: string
  database: string
}

interface WaitingPrompt {
  prompt: ProductionPrompt
  resolve: (ok: boolean) => void
}

interface ProductionGuardState {
  pending: WaitingPrompt | null
  /** Shows the prompt and resolves with the answer. A newer request replaces a waiting one, which resolves false. */
  requestConfirm: (prompt: ProductionPrompt) => Promise<boolean>
  settle: (ok: boolean) => void
}

/** The confirmation shown for production connections. Mounted once in the database layout. */
export const useProductionGuardStore = create<ProductionGuardState>()((set, get) => ({
  pending: null,
  requestConfirm: (prompt) =>
    new Promise<boolean>((resolve) => {
      get().pending?.resolve(false)
      set({ pending: { prompt, resolve } })
    }),
  settle: (ok) => {
    const current = get().pending
    if (!current) return
    set({ pending: null })
    current.resolve(ok)
  },
}))

/**
 * Returns a function that resolves true at once for a connection that is not production.
 * For a production connection (or one whose info is not loaded yet) it asks first and resolves
 * with the answer. false means the change must not run.
 */
export function useProductionGuard(connectionId: string, database: string) {
  const { data: connection } = useQuery(connectionQuery(connectionId))
  const latest = useRef(connection)
  useLayoutEffect(() => {
    latest.current = connection
  }, [connection])

  return async (request: ProductionRequest): Promise<boolean> => {
    const conn = latest.current
    if (conn && conn.production !== true) return true
    return useProductionGuardStore.getState().requestConfirm({
      ...request,
      connectionName: conn?.name ?? 'this connection',
      database,
    })
  }
}
