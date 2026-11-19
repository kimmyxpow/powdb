import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useBlocker, useNavigate } from '@tanstack/react-router'
import { CopyIcon, SquareTerminalIcon } from 'lucide-react'
import { useEffect, useEffectEvent } from 'react'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { relationIcons } from '@/components/app/relation-icons'
import { SqlCodeView } from '@/components/sql/codemirror'
import { pendingStats } from '@/components/table/pending'
import { usePendingHistory } from '@/hooks/use-pending-history'
import { StructureView } from '@/components/table/structure-view'
import { TableData } from '@/components/table/table-data'
import type { TableSearch } from '@/components/table/table-data'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { copyWithToast } from '@/components/app/copy-feedback'
import { countLabel, formatBytes, relationKindLabel } from '@/lib/format'
import { connectionQuery, countQuery, relationDdlQuery, relationDetailsQuery, rowsQuery } from '@/lib/queries'
import { displayQualified } from '@/lib/sql'
import { countParams, parseTableSearch, rowsParams } from '@/lib/table-search'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/c/$connId/$db/t/$schema/$table')({
  validateSearch: (search: Record<string, unknown>): TableSearch => parseTableSearch(search),
  // the search fields the queries below depend on: a change of any of them runs the loader again
  loaderDeps: ({ search }) => ({
    tab: search.tab,
    page: search.page,
    size: search.size,
    sort: search.sort,
    filters: search.filters,
    where: search.where,
    q: search.q,
  }),
  // not awaited: the page renders at once and the queries fill it in. Hovering a link runs this too
  // (defaultPreload: 'intent'), so the data is often there before the click.
  loader: ({ params, deps, context }) => {
    const { connId, db, schema, table } = params
    const queryClient = context.queryClient
    void queryClient.prefetchQuery(relationDetailsQuery(connId, db, schema, table))
    void queryClient.prefetchQuery(countQuery(connId, db, schema, table, { filters: [] }))
    if ((deps.tab ?? 'data') === 'data') {
      void queryClient.prefetchQuery(
        rowsQuery(connId, db, schema, table, rowsParams(deps, useAppStore.getState().pageSize)),
      )
      void queryClient.prefetchQuery(countQuery(connId, db, schema, table, countParams(deps)))
    }
  },
  head: ({ params }) => ({ meta: [{ title: `${params.table} · ${params.db} · pow/view` }] }),
  component: TablePage,
})

function TablePage() {
  const { connId, db, schema, table } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const tab = search.tab ?? 'data'
  const { data: connection } = useQuery(connectionQuery(connId))
  const detailsQ = useQuery(relationDetailsQuery(connId, db, schema, table))
  const details = detailsQ.data
  // the size of the whole table (the filtered count lives in the pager), shared with the
  // unfiltered grid's count query, so the header does not change while filtering
  const { data: tableCount } = useQuery(countQuery(connId, db, schema, table, { filters: [] }))
  const rowCount =
    tableCount ?? (details?.estimatedRows != null ? { count: details.estimatedRows, exact: false } : null)
  const history = usePendingHistory()
  const { pending, setPending } = history
  const dirty = pendingStats(pending).total > 0

  const setSchema = useAppStore((s) => s.setSchema)
  const pushRecent = useAppStore((s) => s.pushRecent)
  const openSqlTab = useAppStore((s) => s.openSqlTab)

  useEffect(() => {
    setSchema(`${connId}:${db}`, schema)
  }, [connId, db, schema, setSchema])
  useEffect(() => {
    if (details) pushRecent(`${connId}:${db}`, { schema, name: table, kind: details.kind })
  }, [details, connId, db, schema, table, pushRecent])

  // pending edits belong to the rows on screen: reset when the view changes
  const viewKey = JSON.stringify([
    connId,
    db,
    schema,
    table,
    search.page,
    search.size,
    search.sort,
    search.filters,
    search.where,
    search.q,
  ])
  // reset() is a new function on every render, so it is read through an effect event, not listed as a dep
  const resetForView = useEffectEvent(() => history.reset())
  useEffect(() => {
    resetForView()
  }, [viewKey])

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (!dirty) return false
      if (current.pathname !== next.pathname) return true
      const a = { ...(current.search as Record<string, unknown>), tab: undefined }
      const b = { ...(next.search as Record<string, unknown>), tab: undefined }
      return JSON.stringify(a) !== JSON.stringify(b)
    },
    enableBeforeUnload: () => dirty,
    withResolver: true,
  })

  const onSearchChange = (patch: Partial<TableSearch>) => {
    void navigate({ search: (prev: TableSearch) => ({ ...prev, ...patch }) })
  }

  const Icon = details ? relationIcons[details.kind] : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card shadow-xs/5">
            {Icon ? <Icon aria-hidden="true" className="size-4 opacity-70" /> : <Skeleton className="size-4" />}
          </span>
          <div className="min-w-0">
            <h1 className="flex min-w-0 items-center gap-2 font-semibold text-base leading-tight">
              <span className="truncate">{table}</span>
              {details && details.kind !== 'r' && <Badge variant="secondary">{relationKindLabel(details.kind)}</Badge>}
              {dirty && <Badge variant="warning">unsaved</Badge>}
            </h1>
            {/* filled in one go once the metadata is here, so no part pushes another aside */}
            <p className="truncate text-muted-foreground text-xs">
              {schema}
              {details && (
                <>
                  {details.totalBytes > 0 && <> · {formatBytes(details.totalBytes)}</>}
                  {/* last, so the estimate → exact count swap moves nothing else */}
                  {rowCount?.count != null && (
                    <>
                      {' · '}
                      {rowCount.exact ? '' : '~'}
                      {countLabel(rowCount.count, 'row')}
                    </>
                  )}
                  {details.comment && <> · {details.comment}</>}
                </>
              )}
            </p>
          </div>
        </div>
        {/* on phones the tabs take a row of their own, so the subtitle length never moves them */}
        <Tabs
          className="ms-auto shrink-0 max-sm:basis-full max-sm:w-full"
          onValueChange={(value) =>
            onSearchChange({ tab: value === 'data' ? undefined : (value as TableSearch['tab']) })
          }
          value={tab}
        >
          <TabsList className="max-sm:w-full">
            <TabsTab value="data">Data</TabsTab>
            <TabsTab value="structure">Structure</TabsTab>
            <TabsTab value="ddl">DDL</TabsTab>
          </TabsList>
        </Tabs>
      </div>

      {detailsQ.error ? (
        <div className="p-6 text-destructive-foreground text-sm">{detailsQ.error.message}</div>
      ) : (
        <>
          <div className={tab === 'data' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <TableData
              connectionId={connId}
              database={db}
              details={details}
              key={JSON.stringify([connId, db, schema, table])}
              onSearchChange={onSearchChange}
              pending={pending}
              readOnly={connection?.readOnly ?? false}
              schema={schema}
              search={search}
              history={history}
              setPending={setPending}
              table={table}
            />
          </div>
          {tab === 'structure' && (
            <StructureView
              canEdit={connection ? !connection.readOnly : false}
              connectionId={connId}
              database={db}
              details={details}
              onRenamed={(name) =>
                void navigate({
                  to: '/c/$connId/$db/t/$schema/$table',
                  params: { connId, db, schema, table: name },
                  search: { tab: 'structure' },
                })
              }
            />
          )}
          {tab === 'ddl' && (
            <DdlView
              connectionId={connId}
              database={db}
              onOpenInEditor={(sql) => {
                openSqlTab(connId, sql, `${table} DDL`)
                void navigate({ to: '/c/$connId/$db/sql', params: { connId, db } })
              }}
              schema={schema}
              table={table}
            />
          )}
        </>
      )}

      <ConfirmDialog
        confirmLabel="Discard changes"
        description="You have unsaved changes in this table. Leaving this view will discard them."
        destructive
        onConfirm={() => blocker.proceed?.()}
        onOpenChange={(open) => !open && blocker.reset?.()}
        open={blocker.status === 'blocked'}
        title="Discard unsaved changes?"
      />
    </div>
  )
}

function DdlView({
  connectionId,
  database,
  schema,
  table,
  onOpenInEditor,
}: {
  connectionId: string
  database: string
  schema: string
  table: string
  onOpenInEditor: (sql: string) => void
}) {
  const { data, isPending, error } = useQuery(relationDdlQuery(connectionId, database, schema, table))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-muted-foreground text-xs">
          Generated from the catalog for <span className="font-mono">{displayQualified(schema, table)}</span>
        </span>
        <div className="flex gap-1">
          <Button
            disabled={!data}
            onClick={() => void copyWithToast(data ?? '', 'DDL copied')}
            size="sm"
            variant="ghost"
          >
            <CopyIcon aria-hidden="true" />
            Copy
          </Button>
          <Button disabled={!data} onClick={() => data && onOpenInEditor(data)} size="sm" variant="outline">
            <SquareTerminalIcon aria-hidden="true" />
            Open in SQL editor
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isPending ? (
          <DdlSkeleton />
        ) : error ? (
          <p className="p-6 text-destructive-foreground text-sm">{error.message}</p>
        ) : (
          <SqlCodeView className="h-full" value={data ?? ''} />
        )}
      </div>
    </div>
  )
}

// Lines in the code view's rhythm (SqlCodeView: 13px mono, line-height 1.6, 10px top padding,
// a 37px gutter: 6px margin plus the line numbers). The frame is clipped, so it keeps its size either way.
const DDL_LINE_WIDTHS = ['w-2/5', 'w-3/5', 'w-1/2', 'w-4/5', 'w-1/3', 'w-2/3', 'w-3/4', 'w-1/4']

function DdlSkeleton() {
  return (
    <div aria-busy="true" className="flex h-full flex-col overflow-hidden py-2.5 font-mono text-[13px] leading-[1.6]">
      <span className="sr-only">Loading DDL</span>
      {Array.from({ length: 60 }, (_, i) => (
        <div className="flex h-[20.8px] shrink-0 items-center" key={i}>
          <div className="flex w-[37px] shrink-0 justify-end pe-2.5">
            <Skeleton className="h-2 w-3 opacity-60" />
          </div>
          <div className="min-w-0 flex-1 ps-1.5">
            <Skeleton className={cn('h-2.5', DDL_LINE_WIDTHS[i % DDL_LINE_WIDTHS.length])} />
          </div>
        </div>
      ))}
    </div>
  )
}
