import { createServerFn } from '@tanstack/react-start'
import type {
  ApplyChangesResult,
  CountResult,
  DatabaseInfo,
  ExecuteResult,
  RelationDetails,
  RelationInfo,
  RowsResult,
  SchemaInfo,
  SchemaObjects,
  ServerInfo,
} from '@/lib/types'
import { explorerValidators } from './validators'

export const serverInfoFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }): Promise<ServerInfo> => {
    const { getServerInfo } = await import('@/server/introspect.server')
    return getServerInfo(data.connectionId, data.database)
  })

export const listDatabasesFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().connectionOnly)
  .handler(async ({ data }): Promise<DatabaseInfo[]> => {
    const { listDatabases } = await import('@/server/introspect.server')
    return listDatabases(data.connectionId)
  })

export const listSchemasFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }): Promise<SchemaInfo[]> => {
    const { listSchemas } = await import('@/server/introspect.server')
    return listSchemas(data.connectionId, data.database)
  })

export const schemaObjectsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().schemaObjects)
  .handler(async ({ data }): Promise<SchemaObjects> => {
    const { listSchemaObjects } = await import('@/server/introspect.server')
    return listSchemaObjects(data.connectionId, data.database, data.schema)
  })

export const allRelationsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }): Promise<RelationInfo[]> => {
    const { listAllRelations } = await import('@/server/introspect.server')
    return listAllRelations(data.connectionId, data.database)
  })

export const relationDetailsFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().relation)
  .handler(async ({ data }): Promise<RelationDetails> => {
    const { getRelationDetails } = await import('@/server/introspect.server')
    return getRelationDetails(data.connectionId, data.database, data.schema, data.table)
  })

export const relationDdlFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().relation)
  .handler(async ({ data }): Promise<string> => {
    const { getRelationDdl } = await import('@/server/introspect.server')
    return getRelationDdl(data.connectionId, data.database, data.schema, data.table)
  })

export const objectDefinitionFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().objectDefinition)
  .handler(async ({ data }): Promise<string> => {
    const { getFunctionDefinition, getTypeDefinition } = await import('@/server/introspect.server')
    return data.kind === 'function'
      ? getFunctionDefinition(data.connectionId, data.database, data.oid)
      : getTypeDefinition(data.connectionId, data.database, data.oid)
  })

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const fetchRowsFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().rowsRequest)
  .handler(async ({ data }): Promise<RowsResult> => {
    const { fetchRows } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return fetchRows(connectionId, database, req)
  })

export const countRowsFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().countRows)
  .handler(async ({ data }): Promise<CountResult> => {
    const { countRows } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return countRows(connectionId, database, req)
  })

export const applyChangesFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().applyChanges)
  .handler(async ({ data }): Promise<ApplyChangesResult> => {
    const { applyChanges } = await import('@/server/data.server')
    const { connectionId, database, ...changes } = data
    return applyChanges(connectionId, database, changes)
  })

export const lookupReferencesFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().lookupReferences)
  .handler(async ({ data }) => {
    const { lookupReferences } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return lookupReferences(connectionId, database, req)
  })

export const referenceLabelsFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().referenceLabels)
  .handler(async ({ data }) => {
    const { referenceLabels } = await import('@/server/data.server')
    const { connectionId, database, ...req } = data
    return referenceLabels(connectionId, database, req)
  })

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const executeSqlFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().executeSql)
  .handler(async ({ data }): Promise<ExecuteResult> => {
    const { executeSql } = await import('@/server/execute.server')
    return executeSql(data.connectionId, data.database, data.sql, {
      maxRows: data.maxRows,
      executionId: data.executionId,
    })
  })

export const cancelSqlFn = createServerFn({ method: 'POST' })
  .validator(explorerValidators().cancelSql)
  .handler(async ({ data }) => {
    const { cancelExecution } = await import('@/server/execute.server')
    return { cancelled: await cancelExecution(data.executionId) }
  })

export const completionSchemaFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }) => {
    const { getCompletionSchema } = await import('@/server/introspect.server')
    return getCompletionSchema(data.connectionId, data.database)
  })

export const databaseOverviewFn = createServerFn({ method: 'GET' })
  .validator(explorerValidators().target)
  .handler(async ({ data }) => {
    const { getDatabaseOverview } = await import('@/server/introspect.server')
    return getDatabaseOverview(data.connectionId, data.database)
  })
