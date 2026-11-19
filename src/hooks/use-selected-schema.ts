import { useParams } from '@tanstack/react-router'
import { useAppStore } from '@/lib/store'

/** The schema shown in the sidebar (remembered per connection + database). */
export function useSelectedSchema(connectionId: string, database: string): [string, (s: string) => void] {
  const key = `${connectionId}:${database}`
  const params = useParams({ strict: false }) as { schema?: string }
  const stored = useAppStore((s) => s.schemaSelection[key])
  const setSchema = useAppStore((s) => s.setSchema)
  const schema = stored ?? params.schema ?? 'public'
  return [schema, (s: string) => setSchema(key, s)]
}
