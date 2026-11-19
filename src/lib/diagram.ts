import { queryOptions } from '@tanstack/react-query'
import { schemaDiagramFn } from '@/api/diagram.functions'
import { keys } from './queries'
import type { RelationKind } from './types'

export interface DiagramColumn {
  name: string
  /** format_type() output, e.g. "integer" or "character varying(255)" */
  type: string
  nullable: boolean
  isPrimaryKey: boolean
  isForeignKey: boolean
}

/** A relation of the diagrammed schema (ordinary, partitioned, view, matview or foreign table). */
export interface DiagramTable {
  name: string
  kind: RelationKind
  /** all non-dropped columns in attnum order */
  columns: DiagramColumn[]
  estimatedRows: number | null
}

/** A foreign key whose source table is one of the schema's diagram tables. */
export interface DiagramForeignKey {
  name: string
  fromTable: string
  fromColumns: string[]
  /** may be another schema (drawn as a ghost node) */
  toSchema: string
  toTable: string
  toColumns: string[]
}

export interface SchemaDiagram {
  schema: string
  tables: DiagramTable[]
  foreignKeys: DiagramForeignKey[]
  /** true when the schema had more than 300 relations; only the first 300 by name are returned */
  truncated: boolean
}

export const DIAGRAM_TABLE_LIMIT = 300

export const schemaDiagramQuery = (connectionId: string, database: string, schema: string) =>
  queryOptions({
    queryKey: [...keys.db(connectionId, database), 'diagram', schema],
    queryFn: () => schemaDiagramFn({ data: { connectionId, database, schema } }),
  })
