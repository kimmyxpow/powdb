import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CornerDownLeftIcon,
  InfoIcon,
  SquareIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ExportMenu } from '@/components/app/export-menu'
import { DataGrid } from '@/components/grid/data-grid'
import type { GridColumn, GridRow } from '@/components/grid/types'
import { LazyRowDrawer, preloadRowDrawer } from '@/components/table/row-drawer-lazy'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { isMac, modKey } from '@/hooks/use-hotkey'
import { exportRows, toTsv } from '@/lib/export'
import { copyWithToast } from '@/components/app/copy-feedback'
import { PlanUnavailable, PlanView, readPlan } from './plan-view'
import type { KnownTable } from '@/lib/explain'
import { countLabel, formatCount, formatDuration } from '@/lib/format'
import type { Cell, ExecuteResult, ExplainResult, Sort, StatementResult } from '@/lib/types'
import { cn } from '@/lib/utils'

const RUNNING_VIEW_DELAY_MS = 300

export interface RunState {
  running: boolean
  startedAt?: number
  result?: ExecuteResult | ExplainResult
  networkError?: string
}

function commandSummary(r: StatementResult): string {
  if (r.fields.length) {
    if (r.truncated) return `${formatCount(r.rows.length)}+ rows`
    return countLabel(r.rowCount ?? r.rows.length, 'row')
  }
  if (r.command && r.rowCount != null && /INSERT|UPDATE|DELETE|MERGE|COPY|MOVE|FETCH/.test(r.command)) {
    return `${r.command} ${formatCount(r.rowCount)}`
  }
  return r.command ?? 'OK'
}

function compareCells(a: Cell, b: Cell, numeric: boolean): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b)
  if (numeric) {
    const na = Number(a)
    const nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  }
  return a.localeCompare(b, undefined, { numeric: true })
}

function ResultGrid({ result, name }: { result: StatementResult; name: string }) {
  const [sort, setSort] = useState<Sort[]>([])
  const [drawer, setDrawer] = useState<string | null>(null)
  const [prevResult, setPrevResult] = useState(result)
  if (result !== prevResult) {
    setPrevResult(result)
    setSort([])
  }

  const columns: GridColumn[] = result.fields.map((f) => ({
    name: f.name,
    typeName: f.typeName,
    kind: f.kind,
    nullable: true,
  }))
  let data = result.rows.map((values, i) => ({ id: String(i), values }))
  if (sort.length) {
    const s = sort[0]!
    const idx = result.fields.findIndex((f) => f.name === s.column)
    if (idx >= 0) {
      const numeric = result.fields[idx]!.kind === 'number'
      data = [...data].sort(
        (a, b) =>
          compareCells(a.values[idx] ?? null, b.values[idx] ?? null, numeric) * (s.direction === 'asc' ? 1 : -1),
      )
    }
  }
  const rows: GridRow[] = data

  const drawerIndex = drawer ? rows.findIndex((r) => r.id === drawer) : -1

  return (
    <>
      <DataGrid
        columns={columns}
        emptyState={<p className="text-muted-foreground text-sm">The query returned no rows.</p>}
        onOpenRow={setDrawer}
        onSortChange={(s) => setSort(s.slice(-1))}
        rows={rows}
        sort={sort}
        storageKey={`sql:${name}:${columns.map((c) => c.name).join(',')}`}
      />
      <LazyRowDrawer
        docked={false}
        columns={columns}
        editable={false}
        onChange={() => {}}
        onClose={() => setDrawer(null)}
        onNext={
          drawerIndex >= 0 && drawerIndex < rows.length - 1 ? () => setDrawer(rows[drawerIndex + 1]!.id) : undefined
        }
        onPrev={drawerIndex > 0 ? () => setDrawer(rows[drawerIndex - 1]!.id) : undefined}
        position={drawerIndex >= 0 ? `Row ${drawerIndex + 1} of ${rows.length}` : undefined}
        row={drawerIndex >= 0 ? rows[drawerIndex]! : null}
        title="Result row"
      />
    </>
  )
}

export function ResultsPanel({
  state,
  onCancel,
  tabName,
  tables,
  onOpenSql,
}: {
  state: RunState | undefined
  onCancel: () => void
  tabName: string
  /** known tables, so a plan can suggest an index */
  tables?: readonly KnownTable[]
  /** opens a suggested SQL in a new tab */
  onOpenSql?: (sql: string) => void
}) {
  const result = state?.result
  const rowResults = (result?.results ?? []).map((r, i) => ({ r, i })).filter(({ r }) => r.fields.length > 0)
  const [view, setView] = useState<string>('messages')

  // an EXPLAIN result carries a plan; it is read once per result, and a bad plan becomes an error
  const planRaw = result && 'plan' in result ? result.plan : null
  const planState = useMemo(
    () => (result && 'plan' in result && result.plan != null ? readPlan(result.plan, result.analyzed) : null),
    [result],
  )
  const parsedPlan = planState && 'plan' in planState ? planState.plan : null
  const planError = planState && 'error' in planState ? planState.error : null
  const planGeneric = result && 'plan' in result ? result.generic : false
  // a plan that cannot be shown for a reason (not an error): the Plan tab explains why
  const unavailable = result && 'unavailable' in result ? result.unavailable : null

  // pick the tab for each new result before paint, otherwise "Messages" flashes before the result grid
  const [prevResult, setPrevResult] = useState<ExecuteResult | ExplainResult | undefined | null>(null)
  if (result !== prevResult) {
    setPrevResult(result)
    if (result) {
      const last = rowResults.at(-1)
      if (parsedPlan || unavailable) setView('plan')
      else setView(!result.error && last ? `r${last.i}` : 'messages')
    }
  }

  // the timer ticks while a query runs, so the elapsed time is shown from the start
  const timerStart = state?.running ? state.startedAt : undefined
  const [tick, setTick] = useState<{ startedAt: number; now: number } | null>(null)
  useLayoutEffect(() => {
    if (!timerStart) return
    const t = setInterval(() => setTick({ startedAt: timerStart, now: Date.now() }), 100)
    return () => clearInterval(t)
  }, [timerStart])

  // the drawer's code is fetched while the browser is idle, so the first open is instant
  useEffect(() => {
    const warm = () => {
      preloadRowDrawer().catch(() => {
        // a failed warm-up is harmless: opening the drawer loads it again and reports the error then
      })
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm)
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(warm, 1500)
    return () => window.clearTimeout(timer)
  }, [])
  // a tick from an earlier run is ignored, so the timer restarts at 0 on each run
  const elapsed = timerStart && tick && tick.startedAt === timerStart ? tick.now - timerStart : 0

  // "Running…" takes over the panel only once a query takes a moment. Until then the
  // previous result stays (with a progress bar), so a quick re-run swaps straight to the
  // new result instead of flashing a spinner in between.
  // (The keys keep React from recycling this view's nodes for the result view, which
  // browsers would report as elements moving rather than one view replacing another.)
  if (state?.running && elapsed >= RUNNING_VIEW_DELAY_MS) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground text-sm"
        key="running"
      >
        <div className="flex items-center gap-2">
          <Spinner />
          {/* fixed width: the centered line must not wobble while the timer ticks */}
          Running… <span className="inline-block min-w-[7ch] tabular-nums">{formatDuration(elapsed)}</span>
        </div>
        <Button onClick={onCancel} size="sm" variant="outline">
          <SquareIcon aria-hidden="true" className="fill-current" />
          Cancel query
        </Button>
      </div>
    )
  }

  if (state?.networkError) {
    return (
      <div className="p-4">
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{state.networkError}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-muted-foreground text-sm">
        <span className="flex size-10 items-center justify-center rounded-xl border bg-card shadow-xs/5">
          <SquareTerminalIcon aria-hidden="true" className="size-4.5" />
        </span>
        <div className="flex flex-col gap-2">
          <span className="flex items-center justify-center gap-2">
            <KbdGroup>
              <Kbd>{modKey}</Kbd>
              <Kbd>
                <CornerDownLeftIcon />
              </Kbd>
            </KbdGroup>
            run selection or whole script
          </span>
          <span className="flex items-center justify-center gap-2">
            <KbdGroup>
              <Kbd>{isMac ? '⇧' : 'Shift'}</Kbd>
              <Kbd>{modKey}</Kbd>
              <Kbd>
                <CornerDownLeftIcon />
              </Kbd>
            </KbdGroup>
            run statement under cursor
          </span>
          <span className="flex items-center justify-center gap-2">
            <KbdGroup>
              <Kbd>{modKey}</Kbd>
              <Kbd>E</Kbd>
            </KbdGroup>
            explain the query plan
          </span>
          <span className="flex items-center justify-center gap-2">
            <KbdGroup>
              <Kbd>{isMac ? '⇧' : 'Shift'}</Kbd>
              <Kbd>{isMac ? '⌥' : 'Alt'}</Kbd>
              <Kbd>F</Kbd>
            </KbdGroup>
            format SQL
          </span>
        </div>
      </div>
    )
  }

  const current = view.startsWith('r') ? result.results[Number(view.slice(1))] : undefined

  const exportCurrent = (format: 'csv' | 'json' | 'sql' | 'md' | 'copy') => {
    if (!current) return
    const fields = current.fields.map((f) => ({ name: f.name, kind: f.kind }))
    if (format === 'copy') {
      void copyWithToast(toTsv(fields, current.rows), `Copied ${countLabel(current.rows.length, 'row')}`)
      return
    }
    exportRows(format, 'query-result', 'query_result', fields, current.rows)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" key="result">
      {state?.running && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
          <div className="h-full w-1/3 animate-[loading_1s_ease-in-out_infinite] bg-primary/60" />
        </div>
      )}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Tabs className="min-w-0 flex-1" onValueChange={(v) => setView(v as string)} value={view}>
          <TabsList className="scrollbar-thin max-w-full justify-start overflow-x-auto" size="sm">
            {(parsedPlan || unavailable) && (
              <TabsTab className="grow-0 text-xs" value="plan">
                Plan
              </TabsTab>
            )}
            {rowResults.map(({ r, i }) => (
              <TabsTab className="grow-0 text-xs" key={i} value={`r${i}`}>
                {rowResults.length > 1 ? `Result ${i + 1}` : 'Result'}
                <span className="font-normal text-muted-foreground tabular-nums">{commandSummary(r)}</span>
              </TabsTab>
            ))}
            <TabsTab className="grow-0 text-xs" value="messages">
              {result.error || planError ? (
                <CircleAlertIcon className="size-3.5 text-destructive" />
              ) : result.notices.some((n) => n.severity === 'WARNING') ? (
                <TriangleAlertIcon className="size-3.5 text-warning" />
              ) : null}
              Messages
              {result.notices.length > 0 && (
                <span className="font-normal text-muted-foreground tabular-nums">{result.notices.length}</span>
              )}
            </TabsTab>
          </TabsList>
        </Tabs>
        <span className="min-w-[calc(7ch+1rem)] shrink-0 px-2 text-right text-muted-foreground text-xs tabular-nums">
          {formatDuration(result.durationMs)}
        </span>
        {current && (
          <ExportMenu
            label="Export result"
            onCopy={() => exportCurrent('copy')}
            onExport={(format) => exportCurrent(format)}
          />
        )}
      </div>

      {view === 'plan' && parsedPlan ? (
        <PlanView generic={planGeneric} onOpenSql={onOpenSql} plan={parsedPlan} raw={planRaw} tables={tables} />
      ) : view === 'plan' && unavailable ? (
        <PlanUnavailable context="editor" reason={unavailable} />
      ) : current ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {current.truncated && (
            <div className="flex items-center gap-2 border-b bg-warning/8 px-3 py-1.5 text-warning-foreground text-xs">
              <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
              Showing the first {formatCount(current.rows.length)} rows. Add a LIMIT or raise the row limit to see more.
            </div>
          )}
          <ResultGrid name={tabName} result={current} />
        </div>
      ) : (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable]">
          <div className="flex flex-col gap-2">
            {planError && (
              <Alert variant="error">
                <CircleAlertIcon />
                <AlertTitle>Could not read the plan</AlertTitle>
                <AlertDescription>{planError}</AlertDescription>
              </Alert>
            )}
            {result.error && (
              <Alert variant="error">
                <CircleAlertIcon />
                <AlertTitle className="break-words">
                  {result.error.message}
                  {result.error.code && (
                    <span className="ms-2 font-mono font-normal text-muted-foreground text-xs">
                      {result.error.code}
                    </span>
                  )}
                </AlertTitle>
                <AlertDescription className="flex flex-col gap-1">
                  {result.error.detail && <span className="whitespace-pre-wrap">{result.error.detail}</span>}
                  {result.error.hint && <span>Hint: {result.error.hint}</span>}
                  {result.error.where && <span className="font-mono text-xs">{result.error.where}</span>}
                  {result.error.statementIndex >= 0 && (
                    <span className="text-xs">
                      In statement {result.error.statementIndex + 1}
                      {result.results.length === 1 && '. The statement before it ran successfully'}
                      {result.results.length > 1 &&
                        `. The ${result.results.length} statements before it ran successfully`}
                      .
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {result.rolledBack && (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>Transaction rolled back</AlertTitle>
                <AlertDescription>
                  The script ended inside an open transaction. Add COMMIT to the same run to keep changes.
                </AlertDescription>
              </Alert>
            )}
            {result.results.map((r, i) => (
              <div className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2 text-sm" key={i}>
                <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{commandSummary(r)}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">{formatDuration(r.durationMs)}</span>
                  </div>
                  <p className="truncate font-mono text-muted-foreground text-xs" title={r.statement}>
                    {r.statement.replace(/\s+/g, ' ')}
                  </p>
                </div>
              </div>
            ))}
            {result.notices.map((n, i) => (
              <div
                className={cn(
                  'flex items-start gap-3 rounded-lg border px-3 py-2 text-sm',
                  n.severity === 'WARNING' ? 'border-warning/32 bg-warning/4' : 'bg-card',
                )}
                key={`n${i}`}
              >
                <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
                <span className="min-w-0 break-words">
                  <span className="me-2 font-mono text-muted-foreground text-xs">{n.severity}</span>
                  {n.message}
                </span>
              </div>
            ))}
            {result.results.length === 0 &&
              !result.error &&
              result.notices.length === 0 &&
              !parsedPlan &&
              !planError && <p className="text-muted-foreground text-sm">Nothing to run.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
