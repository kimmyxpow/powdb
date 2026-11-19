import { createFileRoute } from '@tanstack/react-router'
import { SchemaDiagram } from '@/components/diagram/schema-diagram'

export const Route = createFileRoute('/c/$connId/$db/diagram')({
  head: ({ params }) => ({ meta: [{ title: `Diagram · ${params.db} · pow/view` }] }),
  component: DiagramPage,
})

function DiagramPage() {
  const { connId, db } = Route.useParams()
  return <SchemaDiagram connectionId={connId} database={db} />
}
