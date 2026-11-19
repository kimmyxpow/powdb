import { createFileRoute, redirect } from '@tanstack/react-router'
import { connectionQuery } from '@/lib/queries'

export const Route = createFileRoute('/c/$connId/')({
  loader: async ({ params, context }) => {
    const conn = await context.queryClient.ensureQueryData(connectionQuery(params.connId))
    throw redirect({
      to: '/c/$connId/$db',
      params: { connId: params.connId, db: conn.database },
      replace: true,
    })
  },
})
