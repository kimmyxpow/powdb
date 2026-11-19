import { createServerFn } from '@tanstack/react-start'
import type { ConnectionInfo, TestConnectionResult } from '@/lib/types'
import type { TunnelEndpoint } from '@/server/tunnel.server'
import { connectionValidators, type ConnectionInput } from './validators'

export const listConnectionsFn = createServerFn({ method: 'GET' }).handler(async (): Promise<ConnectionInfo[]> => {
  const { listConnections, toInfo } = await import('@/server/store.server')
  return (await listConnections()).map(toInfo)
})

export const getConnectionFn = createServerFn({ method: 'GET' })
  .validator(connectionValidators().connectionId)
  .handler(async ({ data }): Promise<ConnectionInfo> => {
    const { getConnection, toInfo } = await import('@/server/store.server')
    return toInfo(await getConnection(data.id))
  })

export const createConnectionFn = createServerFn({ method: 'POST' })
  .validator(connectionValidators().connectionInput)
  .handler(async ({ data }): Promise<ConnectionInfo> => {
    const { createConnection, toInfo } = await import('@/server/store.server')
    return toInfo(await createConnection(data))
  })

export const updateConnectionFn = createServerFn({ method: 'POST' })
  .validator(connectionValidators().updateConnection)
  .handler(async ({ data }): Promise<ConnectionInfo> => {
    const { updateConnection, toInfo } = await import('@/server/store.server')
    const { closePools } = await import('@/server/pool.server')
    const conn = await updateConnection(data.id, data.input)
    await closePools(data.id)
    return toInfo(conn)
  })

export const deleteConnectionFn = createServerFn({ method: 'POST' })
  .validator(connectionValidators().connectionId)
  .handler(async ({ data }) => {
    const { deleteConnection } = await import('@/server/store.server')
    const { closePools } = await import('@/server/pool.server')
    await closePools(data.id)
    await deleteConnection(data.id)
    return { ok: true }
  })

export const touchConnectionFn = createServerFn({ method: 'POST' })
  .validator(connectionValidators().connectionId)
  .handler(async ({ data }) => {
    const { touchConnection } = await import('@/server/store.server')
    await touchConnection(data.id)
    return { ok: true }
  })

/**
 * The connection to test before saving: typed secrets win, else the saved ones (when editing).
 * Secrets stay sealed, as in a saved connection. The draft is only tested, never saved.
 */
async function draftFor(id: string | undefined, input: ConnectionInput) {
  const { getConnection } = await import('@/server/store.server')
  const { encryptSecret } = await import('@/server/secret.server')
  const { draftConnection } = await import('@/server/draft-connection')
  const saved = id ? await getConnection(id).catch(() => null) : null
  return draftConnection(saved, input, encryptSecret)
}

/** Test either a saved connection (id) merged with new input, or fresh input. Tunnels first when SSH is set. */
export const testConnectionFn = createServerFn({ method: 'POST' })
  .validator(connectionValidators().testConnection)
  .handler(async ({ data }): Promise<TestConnectionResult> => {
    const { clientConfig, pgErrorInfo } = await import('@/server/pool.server')
    const { testConnection } = await import('@/server/execute.server')
    const { testTunnel } = await import('@/server/tunnel.server')
    const draft = await draftFor(data.id, data.input)
    let close: (() => void) | undefined
    try {
      let endpoint: TunnelEndpoint | undefined
      let hostKey: string | undefined
      if (draft.ssh) {
        const tunnel = await testTunnel(draft.ssh, draft.host, draft.port, draft.name)
        close = tunnel.close
        endpoint = tunnel.endpoint
        hostKey = tunnel.hostKey
      }
      const { latencyMs, serverVersion } = await testConnection(clientConfig(draft, undefined, endpoint))
      return { ok: true, latencyMs, serverVersion, hostKey }
    } catch (err) {
      return { ok: false, error: pgErrorInfo(err).message }
    } finally {
      close?.()
    }
  })
