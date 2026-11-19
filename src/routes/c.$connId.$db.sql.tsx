import { createFileRoute } from '@tanstack/react-router'
import { SqlWorkspace } from '@/components/sql/sql-workspace'

export const Route = createFileRoute('/c/$connId/$db/sql')({
  head: ({ params }) => ({ meta: [{ title: `SQL · ${params.db} · PowDB` }] }),
  component: SqlPage,
})

function SqlPage() {
  const { connId, db } = Route.useParams()
  return <SqlWorkspace connectionId={connId} database={db} />
}
