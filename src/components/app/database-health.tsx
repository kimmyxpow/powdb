import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { CopyIcon, HeartPulseIcon, RefreshCwIcon, SquareTerminalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { DatabaseHealth as HealthReport, StatementsHealth } from '@/server/health.server'
import { copyWithToast } from '@/components/app/copy-feedback'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Frame, FrameHeader, FramePanel, FrameTitle } from '@/components/ui/frame'
import { Meter, MeterIndicator, MeterTrack } from '@/components/ui/meter'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { useInView } from '@/hooks/use-in-view'
import { formatBytes, formatCount, formatDuration, timeAgo } from '@/lib/format'
import { healthQuery } from '@/lib/queries'
import { qualifiedName } from '@/lib/sql'
import { useAppStore } from '@/lib/store'
import { cn } from '@/lib/utils'

type TabId = 'slow' | 'unused' | 'vacuum' | 'reads'

/** What every tab needs from the page: the connection and a way to open SQL in the editor. */
interface Scope {
  connectionId: string
  database: string
  openInEditor: (sql: string) => void
}

const CREATE_EXTENSION_SQL = 'CREATE EXTENSION pg_stat_statements;'
const LOADING_ROWS = 5

export function DatabaseHealth({ connectionId, database }: { connectionId: string; database: string }) {
  const navigate = useNavigate()
  const openSqlTab = useAppStore((s) => s.openSqlTab)
  // starts out of view, so nothing is read until the section scrolls into view
  const [listRef, inView] = useInView<HTMLDivElement>(false)
  const [tab, setTab] = useState<TabId>('slow')

  // Once fetched, the data stays on screen while the section is out of view. Coming back into view
  // refetches only when the data is older than the stale time.
  const {
    data: report,
    error,
    isFetching,
    refetch,
  } = useQuery({
    ...healthQuery(connectionId, database),
    enabled: inView,
  })

  const scope: Scope = {
    connectionId,
    database,
    openInEditor: (sql) => {
      openSqlTab(connectionId, sql)
      void navigate({ to: '/c/$connId/$db/sql', params: { connId: connectionId, db: database } })
    },
  }

  // without data there is nothing to show under the tabs, so the error replaces them
  const failed = error && !report

  return (
    <Frame ref={listRef}>
      <FrameHeader className="flex-row items-center justify-between gap-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <HeartPulseIcon aria-hidden="true" className="size-4 opacity-60" />
          <FrameTitle>Health</FrameTitle>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Refresh"
                disabled={isFetching}
                onClick={() => void refetch()}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <RefreshCwIcon aria-hidden="true" className={cn(isFetching && 'animate-spin')} />
          </TooltipTrigger>
          <TooltipPopup>Refresh</TooltipPopup>
        </Tooltip>
      </FrameHeader>

      <FramePanel className="p-0">
        {error && (
          <Alert className="m-3" variant="error">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {!failed && (
          <Tabs className="gap-0" onValueChange={(v) => setTab(v as TabId)} value={tab}>
            <div className="border-b px-3 py-2">
              <TabsList className="scrollbar-thin max-w-full justify-start overflow-x-auto" size="sm">
                <TabsTab className="grow-0 gap-1.5 text-xs" value="slow">
                  Slow queries
                  <TabCount count={report?.statements.rows.length} />
                </TabsTab>
                <TabsTab className="grow-0 gap-1.5 text-xs" value="unused">
                  Unused indexes
                  <TabCount count={report?.unusedIndexes.length} />
                </TabsTab>
                <TabsTab className="grow-0 gap-1.5 text-xs" value="vacuum">
                  Needs vacuum
                  <TabCount count={report?.vacuum.length} />
                </TabsTab>
                <TabsTab className="grow-0 gap-1.5 text-xs" value="reads">
                  Full table reads
                  <TabCount count={report?.fullReads.length} />
                </TabsTab>
              </TabsList>
            </div>

            <TabsPanel className="p-1" value="slow">
              <SlowQueriesTab scope={scope} statements={report?.statements} />
            </TabsPanel>
            <TabsPanel className="p-1" value="unused">
              <UnusedIndexesTab report={report} scope={scope} />
            </TabsPanel>
            <TabsPanel className="p-1" value="vacuum">
              <VacuumTab report={report} scope={scope} />
            </TabsPanel>
            <TabsPanel className="p-1" value="reads">
              <FullReadsTab report={report} scope={scope} />
            </TabsPanel>
          </Tabs>
        )}
      </FramePanel>
    </Frame>
  )
}

/** Count badge for a tab. A skeleton of the same size shows until the count is known. */
function TabCount({ count }: { count: number | undefined }) {
  if (count === undefined) return <Skeleton aria-hidden="true" className="h-5 w-5 rounded-[.25rem] sm:h-4 sm:w-4" />
  return (
    <Badge size="sm" variant="secondary">
      {formatCount(count)}
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface Column {
  id: string
  label: ReactNode
  className?: string
  /** what a cell shows while loading, sized like the real content */
  placeholder: ReactNode
}

/** One row: the content of each cell, by column id. */
interface HealthRow {
  key: string
  cells: Record<string, ReactNode>
}

/** One line of text in a table cell, as a placeholder of the same height. */
function bar(width: string, opts: { right?: boolean; small?: boolean } = {}) {
  return (
    <span className={cn('flex items-center', opts.small ? 'h-3' : 'h-3.5', opts.right && 'justify-end')}>
      <Skeleton className={cn('h-2.5', width)} />
    </span>
  )
}

const ACTION_COLUMN: Column = {
  id: 'action',
  label: <span className="sr-only">Actions</span>,
  className: 'w-10 text-right',
  placeholder: <Skeleton className="ms-auto size-6 rounded-md" />,
}

/**
 * The rows of a table. While `rows` is not known, LOADING_ROWS placeholder rows with the same
 * columns are shown, so the table keeps its size when the data arrives.
 */
function HealthTable({ columns, rows }: { columns: Column[]; rows?: HealthRow[] }) {
  return (
    <Table aria-busy={rows === undefined || undefined}>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead className={c.className} key={c.id}>
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows === undefined
          ? Array.from({ length: LOADING_ROWS }, (_, i) => (
              <TableRow key={`loading-${i}`}>
                {columns.map((c) => (
                  <TableCell className={c.className} key={c.id}>
                    {c.placeholder}
                  </TableCell>
                ))}
              </TableRow>
            ))
          : rows.map((row) => (
              <TableRow key={row.key}>
                {columns.map((c) => (
                  <TableCell className={c.className} key={c.id}>
                    {row.cells[c.id]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
      </TableBody>
    </Table>
  )
}

/** A line in the middle of the panel: an empty result, or a note. */
function CenteredLine({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-muted-foreground text-sm">{children}</p>
}

/** Muted hint above a table. Always shown, so the layout does not move when the data arrives. */
function Hint({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-2 pb-1 text-muted-foreground text-xs">{children}</p>
}

function OpenInEditorButton({ sql, scope }: { sql: string; scope: Scope }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open in SQL editor"
            onClick={() => scope.openInEditor(sql)}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <SquareTerminalIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>Open in SQL editor</TooltipPopup>
    </Tooltip>
  )
}

function RelationLink({ scope, schema, table }: { scope: Scope; schema: string; table: string }) {
  return (
    <Link
      className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      params={{ connId: scope.connectionId, db: scope.database, schema, table }}
      search={{}}
      to="/c/$connId/$db/t/$schema/$table"
    >
      <QualifiedText name={table} schema={schema} />
    </Link>
  )
}

/** The name, with the schema in front when it is not public. */
function QualifiedText({ schema, name }: { schema: string; name: string }) {
  return (
    <>
      {schema !== 'public' && <span className="font-normal text-muted-foreground">{schema}.</span>}
      {name}
    </>
  )
}

/** "12.3%", or "<0.1%" for a very small share. Input is a fraction from 0 to 1. */
function percent(fraction: number): string {
  const p = fraction * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`
}

/** The statement on one line; the full text stays in the title attribute. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const SLOW_COLUMNS: Column[] = [
  { id: 'query', label: 'Query', className: 'max-w-0 w-full', placeholder: bar('w-3/4', { small: true }) },
  {
    id: 'calls',
    label: 'Calls',
    className: 'hidden text-right tabular-nums sm:table-cell',
    placeholder: bar('w-10', { right: true }),
  },
  {
    id: 'avg',
    label: 'Avg time',
    className: 'text-right whitespace-nowrap tabular-nums',
    placeholder: bar('w-12', { right: true }),
  },
  {
    id: 'total',
    label: 'Total time',
    className: 'hidden text-right whitespace-nowrap tabular-nums sm:table-cell',
    placeholder: bar('w-14', { right: true }),
  },
  {
    id: 'share',
    label: 'Share',
    className: 'w-14 text-right sm:w-44',
    placeholder: (
      <span className="flex h-3 items-center justify-end gap-2">
        <Skeleton className="h-1 w-20 rounded-full max-sm:hidden" />
        <Skeleton className="h-2.5 w-8" />
      </span>
    ),
  },
  ACTION_COLUMN,
]

function SlowQueriesTab({ statements, scope }: { statements: StatementsHealth | undefined; scope: Scope }) {
  if (!statements) return <HealthTable columns={SLOW_COLUMNS} />
  if (statements.status === 'not-installed') return <NotInstalled />
  if (statements.status === 'not-loaded') {
    return (
      <Alert className="m-2" variant="warning">
        <AlertDescription>
          The pg_stat_statements extension exists, but Postgres did not load it. Add it to shared_preload_libraries and
          restart Postgres.
        </AlertDescription>
      </Alert>
    )
  }
  if (statements.status === 'error') {
    return (
      <Alert className="m-2" variant="error">
        <AlertDescription>{statements.message}</AlertDescription>
      </Alert>
    )
  }
  if (statements.rows.length === 0) return <CenteredLine>No slow queries recorded yet.</CenteredLine>
  return (
    <HealthTable
      columns={SLOW_COLUMNS}
      rows={statements.rows.map((r, i) => ({
        key: String(i),
        cells: {
          query:
            r.query === null ? (
              <span className="italic text-muted-foreground text-xs">Hidden. Another user ran it.</span>
            ) : (
              <span className="block truncate font-mono text-xs" title={r.query}>
                {oneLine(r.query)}
              </span>
            ),
          calls: formatCount(r.calls, { compact: true }),
          avg: formatDuration(r.meanMs),
          total: formatDuration(r.totalMs),
          share: (
            <span className="flex items-center justify-end gap-2 text-xs tabular-nums">
              <Meter
                aria-label={`${percent(r.share)} of total time`}
                className="w-20 max-sm:hidden"
                max={1}
                value={r.share}
              >
                <MeterTrack className="h-1 rounded-full">
                  <MeterIndicator className="rounded-full bg-primary/70" />
                </MeterTrack>
              </Meter>
              <span className="w-10 text-right">{percent(r.share)}</span>
            </span>
          ),
          action: r.query === null ? null : <OpenInEditorButton scope={scope} sql={r.query} />,
        },
      }))}
    />
  )
}

/** Shown when pg_stat_statements is not created in this database. */
function NotInstalled() {
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <p>Turn on pg_stat_statements to see which queries take the most time.</p>
      <ol className="flex list-decimal flex-col gap-2 ps-5 text-muted-foreground">
        <li>Add pg_stat_statements to shared_preload_libraries in postgresql.conf and restart Postgres.</li>
        <li>
          {/* the flex layout sits inside the item, so the list keeps its number */}
          <div className="flex flex-col items-start gap-2">
            <span>Run this in the database:</span>
            <span className="flex flex-wrap items-center gap-2">
              <code className="rounded-md border bg-muted/30 px-2 py-1 font-mono text-foreground text-xs">
                {CREATE_EXTENSION_SQL}
              </code>
              <Button
                aria-label="Copy SQL"
                onClick={() => void copyWithToast(CREATE_EXTENSION_SQL, 'SQL copied')}
                size="xs"
                variant="outline"
              >
                <CopyIcon aria-hidden="true" />
                Copy
              </Button>
            </span>
          </div>
        </li>
      </ol>
    </div>
  )
}

const UNUSED_COLUMNS: Column[] = [
  { id: 'index', label: 'Index', className: 'max-w-0 w-full', placeholder: bar('w-40') },
  { id: 'table', label: 'Table', className: 'max-w-40', placeholder: bar('w-24') },
  {
    id: 'size',
    label: 'Size',
    className: 'text-right whitespace-nowrap tabular-nums',
    placeholder: bar('w-14', { right: true }),
  },
  ACTION_COLUMN,
]

function UnusedIndexesTab({ report, scope }: { report: HealthReport | undefined; scope: Scope }) {
  return (
    <>
      <Hint>
        Not used since the statistics were reset{report?.statsSince ? ` ${timeAgo(report.statsSince)}` : ''}. Indexes
        still take space and slow down writes. Check replicas before you drop one.
      </Hint>
      {!report ? (
        <HealthTable columns={UNUSED_COLUMNS} />
      ) : report.unusedIndexes.length === 0 ? (
        <CenteredLine>No unused indexes.</CenteredLine>
      ) : (
        <HealthTable
          columns={UNUSED_COLUMNS}
          rows={report.unusedIndexes.map((ix) => ({
            key: `${ix.schema}.${ix.index}`,
            cells: {
              index: (
                <span className="block truncate font-medium">
                  <QualifiedText name={ix.index} schema={ix.schema} />
                </span>
              ),
              table: <RelationLink scope={scope} schema={ix.schema} table={ix.table} />,
              size: formatBytes(ix.bytes),
              action: (
                <OpenInEditorButton
                  scope={scope}
                  sql={`DROP INDEX CONCURRENTLY ${qualifiedName(ix.schema, ix.index)};`}
                />
              ),
            },
          }))}
        />
      )}
    </>
  )
}

const VACUUM_COLUMNS: Column[] = [
  { id: 'table', label: 'Table', className: 'max-w-0 w-full', placeholder: bar('w-36') },
  {
    id: 'dead',
    label: 'Dead rows',
    className: 'text-right whitespace-nowrap tabular-nums',
    placeholder: bar('w-14', { right: true }),
  },
  {
    id: 'deadShare',
    label: 'Dead share',
    className: 'hidden text-right whitespace-nowrap tabular-nums sm:table-cell',
    placeholder: bar('w-12', { right: true }),
  },
  {
    id: 'lastVacuum',
    label: 'Last vacuum',
    className: 'hidden text-right whitespace-nowrap sm:table-cell',
    placeholder: bar('w-16', { right: true }),
  },
  ACTION_COLUMN,
]

function VacuumTab({ report, scope }: { report: HealthReport | undefined; scope: Scope }) {
  return (
    <>
      <Hint>Deleted and updated rows still take space until VACUUM clears them.</Hint>
      {!report ? (
        <HealthTable columns={VACUUM_COLUMNS} />
      ) : report.vacuum.length === 0 ? (
        <CenteredLine>No table needs a vacuum.</CenteredLine>
      ) : (
        <HealthTable
          columns={VACUUM_COLUMNS}
          rows={report.vacuum.map((t) => ({
            key: `${t.schema}.${t.table}`,
            cells: {
              table: <RelationLink scope={scope} schema={t.schema} table={t.table} />,
              dead: formatCount(t.deadRows),
              deadShare: percent(t.deadRows / Math.max(t.deadRows + t.liveRows, 1)),
              lastVacuum: t.lastVacuum ? timeAgo(t.lastVacuum) : 'Never',
              action: (
                <OpenInEditorButton scope={scope} sql={`VACUUM (ANALYZE) ${qualifiedName(t.schema, t.table)};`} />
              ),
            },
          }))}
        />
      )}
    </>
  )
}

const READS_COLUMNS: Column[] = [
  { id: 'table', label: 'Table', className: 'max-w-0 w-full', placeholder: bar('w-36') },
  {
    id: 'seq',
    label: 'Full reads',
    className: 'text-right whitespace-nowrap tabular-nums',
    placeholder: bar('w-12', { right: true }),
  },
  {
    id: 'idx',
    label: 'Index reads',
    className: 'hidden text-right whitespace-nowrap tabular-nums sm:table-cell',
    placeholder: bar('w-12', { right: true }),
  },
  {
    id: 'rowsRead',
    label: 'Rows read',
    className: 'hidden text-right whitespace-nowrap tabular-nums sm:table-cell',
    placeholder: bar('w-14', { right: true }),
  },
  {
    id: 'rows',
    label: 'Rows',
    className: 'text-right whitespace-nowrap tabular-nums',
    placeholder: bar('w-12', { right: true }),
  },
]

function FullReadsTab({ report, scope }: { report: HealthReport | undefined; scope: Scope }) {
  return (
    <>
      <Hint>
        Big tables that are read in full more often than through an index. Explain a slow query on them to find a
        missing index.
      </Hint>
      {!report ? (
        <HealthTable columns={READS_COLUMNS} />
      ) : report.fullReads.length === 0 ? (
        <CenteredLine>No big table is read in full often.</CenteredLine>
      ) : (
        <HealthTable
          columns={READS_COLUMNS}
          rows={report.fullReads.map((t) => ({
            key: `${t.schema}.${t.table}`,
            cells: {
              table: <RelationLink scope={scope} schema={t.schema} table={t.table} />,
              seq: formatCount(t.seqScans, { compact: true }),
              idx: formatCount(t.indexScans, { compact: true }),
              rowsRead: formatCount(t.rowsRead, { compact: true }),
              rows: formatCount(t.liveRows, { compact: true }),
            },
          }))}
        />
      )}
    </>
  )
}
