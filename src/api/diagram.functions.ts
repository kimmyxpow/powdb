import { createServerFn } from '@tanstack/react-start'
import type { SchemaDiagram } from '@/lib/diagram'
import { diagramValidators } from './validators'

export const schemaDiagramFn = createServerFn({ method: 'GET' })
  .validator(diagramValidators().schemaDiagram)
  .handler(async ({ data }): Promise<SchemaDiagram> => {
    const { schemaDiagram } = await import('@/server/diagram.server')
    return schemaDiagram(data.connectionId, data.database, data.schema)
  })
