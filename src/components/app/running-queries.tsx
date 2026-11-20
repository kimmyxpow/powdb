import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  CircleStopIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PowerOffIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { signalBackendFn } from '@/api/activity.functions'
import type { ActivityRow } from '@/server/activity.server'
import { CopyButton } from '@/components/app/copy-button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import type { BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Frame, FrameHeader, FramePanel, FrameTitle } from '@/components/ui/frame'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { toastManager } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { useInView } from '@/hooks/use-in-view'
import { useRetained } from '@/hooks/use-retained'
import { activityQuery } from '@/lib/activity-queries'
import { formatDuration } from '@/lib/format'
import { connectionQuery } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/lib/store'

type Action = 'cancel' | 'terminate'
interface Pending {
  row: ActivityRow
  action: Action
}

const SLOW_MS = 60_000
const REFRESH_MS = 5_000

export function RunningQueries({ connectionId, database }: { connectionId: string; database: string }) {
  const navigate = useNavigate()
  const openSqlTab = useAppStore((s) => s.openSqlTab)
  const [hideIdle, setHideIdle] = useState(true)
  const [allDatabases, setAllDatabases] = useState(false)
  const [paused, setPaused] = useState(false)
  const [detail, setDetail] = useState<ActivityRow | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [listRef, inView] = useInView<HTMLDivElement>()

  // Until the connection loads, treat it as read-only so no action fires by mistake.
  const { data: conn } = useQuery(connectionQuery(connectionId))
  const readOnly = conn?.readOnly !== false
  const production = conn?.production === true

  const {
    data: rows,
    error,
    isPending,
    isFetching,
    refetch,
  } = useQuery({
    ...activityQuery(connectionId, database, allDatabases),
    refetchInterval: paused || !inView ? false : REFRESH_MS,
  })

  // TanStack Query does not refetch when the interval turns back on, so catch up here.
  const wasInView = useRef(inView)
  useEffect(() => {
    const was = wasInView.current
    wasInView.current = inView
    if (inView && !was) void refetch()
  }, [inView, refetch])

  const visible = rows?.filter((r) => !hideIdle || r.state !== 'idle')

  // A refresh that finds no change looks like nothing happened, so it reports back.
  const refreshNow = () => {
    void refetch().then((res) => {
      if (res.error) toastManager.add({ type: 'error', title: 'Could not refresh', description: res.error.message })
      else toastManager.add({ type: 'success', title: 'Queries refreshed', timeout: 1500 })
    })
  }

  const signal = useMutation({
    mutationFn: ({ row, action }: Pending) =>
      signalBackendFn({ data: { connectionId, database, pid: row.pid, action } }),
    onSuccess: (_data, { action }) => {
      toastManager.add({
        type: 'success',
        title: action === 'cancel' ? 'Query cancelled' : 'Connection terminated',
      })
      setPending(null)
      void refetch()
    },
    onError: (err, { action }) => {
      toastManager.add({
        type: 'error',
        title: action === 'cancel' ? 'Could not cancel query' : 'Could not terminate connection',
        description: err.message,
      })
      setPending(null)
    },
  })

  const confirm = confirmContent(pending)

  return (
    <Frame ref={listRef}>
      <FrameHeader className="flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <FrameTitle>Running queries</FrameTitle>
            {paused && (
              <Badge size="sm" variant="secondary">
                Paused
              </Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={hideIdle} onCheckedChange={setHideIdle} />
            Hide idle
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={allDatabases} onCheckedChange={setAllDatabases} />
            All databases
          </label>
          <Button
            aria-label={paused ? 'Resume refresh' : 'Pause refresh'}
            onClick={() => setPaused((p) => !p)}
            size="icon-sm"
            variant="ghost"
          >
            {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
          </Button>
          <Button aria-label="Refresh" disabled={isFetching} onClick={refreshNow} size="icon-sm" variant="ghost">
            <RefreshCwIcon aria-hidden="true" className={cn(isFetching && 'animate-spin')} />
          </Button>
        </div>
      </FrameHeader>

      <FramePanel className="p-0">
        {error && (
          <Alert className="m-3 w-auto" variant="error">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {isPending && !error ? (
          // the box of the empty state (p-6 around one text-sm line), the usual result with "Hide idle" on
          <div aria-busy="true" className="p-6">
            <Skeleton className="mx-auto h-5 w-44" />
          </div>
        ) : visible && visible.length > 0 ? (
          <Table className="min-w-[46rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">PID</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Application</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Waiting</TableHead>
                {allDatabases && <TableHead>Database</TableHead>}
                <TableHead>Query</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow
                  className="cursor-pointer"
                  key={r.pid}
                  onClick={() => setDetail(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setDetail(r)
                    }
                  }}
                  tabIndex={0}
                >
                  <TableCell className="font-mono tabular-nums">{r.pid}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.usename ?? ''}</TableCell>
                  <TableCell className="max-w-48">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-muted-foreground">{r.applicationName ?? ''}</span>
                      {r.isPowview && (
                        <Badge size="sm" variant="info">
                          pow/view
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge size="sm" variant={stateVariant(r.state)}>
                      {r.state ?? 'unknown'}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'whitespace-nowrap text-right tabular-nums',
                      isSlow(r) && 'font-medium text-warning-foreground',
                    )}
                  >
                    {r.durationMs == null ? '' : formatDuration(r.durationMs)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <WaitingCell row={r} />
                  </TableCell>
                  {allDatabases && <TableCell className="whitespace-nowrap">{r.datname ?? ''}</TableCell>}
                  <TableCell className="max-w-0 w-full">
                    <span className="block max-w-md truncate font-mono text-xs">{oneLine(r.query)}</span>
                  </TableCell>
                  <TableCell
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Menu>
                      <MenuTrigger
                        render={<Button aria-label={`Actions for pid ${r.pid}`} size="icon-xs" variant="ghost" />}
                      >
                        <MoreHorizontalIcon aria-hidden="true" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {readOnly && (
                          <p className="px-2 py-1.5 text-muted-foreground text-xs">This connection is read-only.</p>
                        )}
                        <MenuItem disabled={readOnly} onClick={() => setPending({ row: r, action: 'cancel' })}>
                          <CircleStopIcon aria-hidden="true" />
                          Cancel query
                        </MenuItem>
                        <MenuItem
                          disabled={readOnly}
                          onClick={() => setPending({ row: r, action: 'terminate' })}
                          variant="destructive"
                        >
                          <PowerOffIcon aria-hidden="true" />
                          Terminate connection
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : isPending || error ? null : (
          <p className="p-6 text-center text-muted-foreground text-sm">
            {hideIdle ? 'No running queries.' : 'No other connections.'}
          </p>
        )}
      </FramePanel>

      <SessionDialog
        onClose={() => setDetail(null)}
        onOpenInEditor={(row) => {
          openSqlTab(connectionId, row.query)
          setDetail(null)
          void navigate({ to: '/c/$connId/$db/sql', params: { connId: connectionId, db: database } })
        }}
        onRequest={(action) => {
          if (!detail) return
          setDetail(null)
          setPending({ row: detail, action })
        }}
        readOnly={readOnly}
        row={detail}
      />

      <ConfirmDialog
        cancelLabel="Keep running"
        confirmLabel={confirm.confirmLabel}
        description={confirm.description}
        destructive={confirm.destructive}
        loading={signal.isPending}
        onConfirm={() => {
          if (pending) signal.mutate(pending)
        }}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        open={pending !== null}
        title={
          production ? (
            <span className="flex flex-wrap items-center gap-2">
              <span>{confirm.title}</span>
              <Badge variant="destructive">Production</Badge>
            </span>
          ) : (
            confirm.title
          )
        }
      />
    </Frame>
  )
}

function confirmContent(pending: Pending | null) {
  const pid = pending?.row.pid ?? 0
  if (pending?.action === 'terminate') {
    return {
      title: `Terminate connection ${pid}?`,
      description: 'The connection closes and any open transaction rolls back.',
      confirmLabel: 'Terminate connection',
      destructive: true,
    }
  }
  return {
    title: `Cancel query ${pid}?`,
    description: 'The query stops and its transaction rolls back. The connection stays open.',
    confirmLabel: 'Cancel query',
    destructive: false,
  }
}

function SessionDialog({
  row,
  readOnly,
  onClose,
  onRequest,
  onOpenInEditor,
}: {
  row: ActivityRow | null
  readOnly: boolean
  onClose: () => void
  onRequest: (action: Action) => void
  onOpenInEditor: (row: ActivityRow) => void
}) {
  // keep the last session on screen while the dialog animates out
  const shown = useRetained(row)
  const facts: [string, string][] = shown
    ? [
        ['User', shown.usename ?? 'Unknown'],
        ['Database', shown.datname ?? 'Unknown'],
        ['Application', shown.applicationName || 'Not set'],
        ['Client', shown.clientAddr ?? 'Local socket'],
        ['Started', formatDate(shown.backendStart)],
        ['Query started', formatDate(shown.queryStart)],
        ['Transaction started', formatDate(shown.xactStart)],
        ['Waiting', waitText(shown) || 'Not waiting'],
        ['Blocked by', shown.blockedBy.length ? shown.blockedBy.join(', ') : 'Nothing'],
      ]
    : []

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={row !== null}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono tabular-nums">PID {shown?.pid}</DialogTitle>
          <DialogDescription>
            {shown?.state ?? 'unknown'}
            {shown?.durationMs != null && ` for ${formatDuration(shown.durationMs)}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div className="relative">
            <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 pe-24 font-mono text-xs">
              {shown?.query || 'No query text.'}
            </pre>
            <div className="absolute end-2 top-2">
              <CopyButton label="Copy query" text={shown?.query ?? ''} />
            </div>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {facts.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </Fragment>
            ))}
          </dl>
        </DialogPanel>
        <DialogFooter>
          <ReadOnlyGuard readOnly={readOnly}>
            <Button disabled={readOnly} onClick={() => onRequest('cancel')} variant="outline">
              <CircleStopIcon aria-hidden="true" />
              Cancel query
            </Button>
          </ReadOnlyGuard>
          <ReadOnlyGuard readOnly={readOnly}>
            <Button disabled={readOnly} onClick={() => onRequest('terminate')} variant="destructive-outline">
              <PowerOffIcon aria-hidden="true" />
              Terminate connection
            </Button>
          </ReadOnlyGuard>
          <Button disabled={!shown} onClick={() => shown && onOpenInEditor(shown)}>
            <SquareTerminalIcon aria-hidden="true" />
            Open in SQL editor
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function ReadOnlyGuard({ readOnly, children }: { readOnly: boolean; children: ReactElement }) {
  if (!readOnly) return children
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>{children}</TooltipTrigger>
      <TooltipPopup>This connection is read-only.</TooltipPopup>
    </Tooltip>
  )
}

function WaitingCell({ row }: { row: ActivityRow }) {
  const wait = waitText(row)
  return (
    <span className="flex flex-col gap-0.5">
      {wait && <span className="text-muted-foreground">{wait}</span>}
      {row.blockedBy.length > 0 && (
        <span className="text-warning-foreground">blocked by {row.blockedBy.join(', ')}</span>
      )}
    </span>
  )
}

function waitText(row: ActivityRow): string {
  return [row.waitEventType, row.waitEvent].filter(Boolean).join(': ')
}

function stateVariant(state: string | null): BadgeProps['variant'] {
  if (state === 'active') return 'success'
  if (state?.startsWith('idle in transaction')) return 'warning'
  if (state === 'idle') return 'outline'
  return 'secondary'
}

function isSlow(row: ActivityRow): boolean {
  return row.state === 'active' && (row.durationMs ?? 0) > SLOW_MS
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Unknown'
}
