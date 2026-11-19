import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlertIcon,
  CheckIcon,
  HistoryIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  SquareIcon,
  TextCursorInputIcon,
  Trash2Icon,
  WandSparklesIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cancelSqlFn, executeSqlFn } from '@/api/explorer.functions'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs'
import { Group as ButtonGroup, GroupSeparator } from '@/components/ui/group'
import { SplitPane } from '@/components/ui-extra/split-pane'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { isMac, shortcut, useHotkey } from '@/hooks/use-hotkey'
import { formatDuration, timeAgo } from '@/lib/format'
import { useProductionGuard } from '@/lib/production-guard'
import { completionSchemaQuery, keys } from '@/lib/queries'
import { savedQueriesQuery, useUpdateSavedQuery } from '@/lib/saved-queries'
import { ensureWorkspace, useAppStore } from '@/lib/store'
import type { SqlTab, SqlWorkspace as SqlWorkspaceState } from '@/lib/store'
import type { ExecuteResult, SavedQuery } from '@/lib/types'
import { classifySql } from '@/lib/sql-safety'
import { cn } from '@/lib/utils'
import { SqlEditor } from './codemirror'
import type { SqlEditorHandle } from './codemirror'
import { ResultsPanel } from './results-panel'
import type { RunState } from './results-panel'
import { SaveQueryDialog } from './save-query-dialog'
import { SavedQueriesPopover } from './saved-queries-popover'

// sql-formatter is loaded through this function: the React Compiler cannot compile import() inside a component
const loadSqlFormatter = () => import('sql-formatter')
type SqlFormat = Awaited<ReturnType<typeof loadSqlFormatter>>['format']

const ROW_LIMITS = [100, 500, 1000, 5000, 20000]
const READ_ONLY_COMMANDS = new Set([
  'SELECT',
  'SHOW',
  'EXPLAIN',
  'VALUES',
  'TABLE',
  'WITH',
  'FETCH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SET',
  'RESET',
  'DISCARD',
])

export function SqlWorkspace({ connectionId, database }: { connectionId: string; database: string }) {
  const workspace = useAppStore((s) => s.sql[connectionId])
  useEffect(() => {
    if (!workspace) ensureWorkspace(connectionId)
  }, [workspace, connectionId])
  if (!workspace) return null
  return <SqlWorkspaceInner connectionId={connectionId} database={database} workspace={workspace} />
}

function SqlWorkspaceInner({
  connectionId,
  database,
  workspace,
}: {
  connectionId: string
  database: string
  workspace: SqlWorkspaceState
}) {
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  const updateTab = useAppStore((s) => s.updateSqlTab)
  const openTab = useAppStore((s) => s.openSqlTab)
  const closeTab = useAppStore((s) => s.closeSqlTab)
  const setActive = useAppStore((s) => s.setActiveSqlTab)
  const addHistory = useAppStore((s) => s.addHistory)
  const maxRows = useAppStore((s) => s.maxRows)
  const setMaxRows = useAppStore((s) => s.setMaxRows)

  const active = workspace.tabs.find((t) => t.id === workspace.activeId) ?? workspace.tabs[0]!
  const editorRef = useRef<SqlEditorHandle>(null)
  const [runs, setRuns] = useState<Record<string, RunState & { executionId?: string }>>({})
  const run = runs[active.id]

  const { data: completion } = useQuery(completionSchemaQuery(connectionId, database))
  const schema = useMemo(() => {
    if (!completion) return undefined
    const ns: Record<string, Record<string, string[]>> = {}
    for (const t of completion.tables) {
      ns[t.schema] = ns[t.schema] ?? {}
      ns[t.schema]![t.name] = t.columns
    }
    return ns
  }, [completion])

  const execute = async (mode: 'auto' | 'statement') => {
    const editor = editorRef.current
    if (!editor) return
    let text: string
    let offset: number
    if (mode === 'statement') {
      const stmt = editor.getStatementAtCursor()
      if (!stmt) return
      text = stmt.text
      offset = stmt.from
    } else {
      const r = editor.getRunText()
      text = r.text
      offset = r.offset
    }
    if (!text.trim()) {
      toastManager.add({ type: 'info', title: 'Nothing to run', description: 'Write a query first.' })
      return
    }
    const tabId = active.id
    if (runs[tabId]?.running) return
    // read-only statements run at once; anything that may change data asks first on production
    const safety = classifySql(text)
    if (safety.changes) {
      const ok = await guard({
        action: 'Run a query that changes data',
        sql: text.trim(),
        destructive: safety.destructive,
      })
      if (!ok) return
    }
    const executionId = crypto.randomUUID()
    editor.showError(null)
    // the previous result stays on screen until the new one arrives (see ResultsPanel)
    setRuns((r) => ({
      ...r,
      [tabId]: { running: true, startedAt: Date.now(), executionId, result: r[tabId]?.result },
    }))
    // The result handling is a closure rather than part of the try block: the React Compiler cannot
    // compile conditionals inside a try block. Anything it throws is still caught below.
    const showResult = (result: ExecuteResult) => {
      setRuns((r) => ({ ...r, [tabId]: { running: false, result } }))
      if (result.error && editorRef.current && workspace.activeId === tabId) {
        if (result.error.position != null) {
          const rest = text.slice(result.error.position)
          const token = /^[\w$."]+/.exec(rest)?.[0] ?? rest.slice(0, 1)
          editor.showError({
            from: offset + result.error.position,
            to: offset + result.error.position + Math.max(1, token.length),
          })
        } else if (result.error.statementIndex >= 0) {
          editor.showError({ from: offset + result.error.from, to: offset + result.error.to })
        }
      }
      const rows = result.results.reduce((acc, s) => acc + (s.fields.length ? s.rows.length : (s.rowCount ?? 0)), 0)
      addHistory(connectionId, {
        sql: text.trim(),
        database,
        at: Date.now(),
        durationMs: result.durationMs,
        ok: !result.error,
        rows,
        error: result.error?.message,
      })
      const changedSomething = result.results.some((s) => s.command && !READ_ONLY_COMMANDS.has(s.command))
      if (changedSomething) {
        void queryClient.invalidateQueries({ queryKey: keys.db(connectionId, database) })
      }
    }
    try {
      showResult(
        await executeSqlFn({
          data: { connectionId, database, sql: text, maxRows, executionId },
        }),
      )
    } catch (err) {
      // read outside the updater: the React Compiler cannot compile a catch variable captured by a closure
      const networkError = (err as Error).message
      setRuns((r) => ({ ...r, [tabId]: { running: false, networkError } }))
    }
  }

  const cancel = async () => {
    const executionId = runs[active.id]?.executionId
    if (!executionId) return
    try {
      await cancelSqlFn({ data: { executionId } })
    } catch (err) {
      toastManager.add({ type: 'error', title: 'Could not cancel', description: (err as Error).message })
    }
  }

  // sql-formatter is large, so it is loaded when first needed. Once the page is idle it is
  // fetched in the background, so the first Format is instant.
  useEffect(() => {
    const warm = () => {
      loadSqlFormatter().catch(() => {
        // a failed warm-up is harmless: Format retries the import and reports the error then
      })
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm)
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(warm, 1000)
    return () => window.clearTimeout(timer)
  }, [])

  const format = async () => {
    const tabId = active.id
    // The formatting is a closure rather than part of the try block: the React Compiler cannot
    // compile conditionals inside a try block. Anything it throws is still caught below.
    const formatTab = (formatSql: SqlFormat) => {
      // the import is async: format the text the tab holds now, and only while it is still the open tab
      const ws = useAppStore.getState().sql[connectionId]
      const tab = ws?.tabs.find((t) => t.id === tabId)
      if (ws?.activeId !== tabId || !tab) return
      const formatted = formatSql(tab.sql, {
        language: 'postgresql',
        keywordCase: 'upper',
        tabWidth: 2,
        linesBetweenQueries: 1,
      })
      editorRef.current?.setValue(formatted)
      editorRef.current?.focus()
    }
    try {
      formatTab((await loadSqlFormatter()).format)
    } catch (err) {
      toastManager.add({
        type: 'error',
        title: 'Could not format',
        description: (err as Error).message.split('\n')[0],
      })
    }
  }

  const { data: savedList } = useQuery(savedQueriesQuery(connectionId))
  const linked = active.savedId ? savedList?.find((q) => q.id === active.savedId) : undefined
  const [saveOpen, setSaveOpen] = useState(false)
  const updateSaved = useUpdateSavedQuery()

  const save = () => {
    if (!active.sql.trim()) {
      toastManager.add({ type: 'info', title: 'Nothing to save', description: 'Write a query first.' })
      return
    }
    if (linked) {
      const sql = active.sql
      const tabId = active.id
      updateSaved.mutate(
        { id: linked.id, patch: { sql } },
        {
          onSuccess: () => {
            updateTab(connectionId, tabId, { savedSql: sql })
            toastManager.add({ type: 'success', title: 'Saved', timeout: 1500 })
          },
          onError: (err) => toastManager.add({ type: 'error', title: 'Could not save', description: err.message }),
        },
      )
      return
    }
    if (active.savedId) {
      // The saved query was deleted: this tab becomes unsaved again.
      if (!savedList) {
        toastManager.add({ type: 'info', title: 'Still loading', description: 'Try again in a moment.' })
        return
      }
      updateTab(connectionId, active.id, { savedId: undefined, savedSql: undefined })
    }
    setSaveOpen(true)
  }

  // also work when focus is outside the editor (toolbar, results grid, …)
  useHotkey('mod+s', () => save(), { allowInInputs: true, enabled: !saveOpen })
  useHotkey('mod+enter', () => void execute('auto'), { allowInInputs: true })
  useHotkey('mod+shift+enter', () => void execute('statement'), { allowInInputs: true })
  useHotkey('mod+.', () => void cancel(), { allowInInputs: true, enabled: Boolean(run?.running) })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabStrip
        activeId={active.id}
        onClose={(id) => closeTab(connectionId, id)}
        onNew={() => openTab(connectionId)}
        onRename={(id, name) => updateTab(connectionId, id, { name })}
        onSelect={(id) => setActive(connectionId, id)}
        runningIds={Object.entries(runs)
          .filter(([, r]) => r.running)
          .map(([id]) => id)}
        savedQueries={savedList}
        tabs={workspace.tabs}
      />

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <ButtonGroup>
          {/* Run turns into Cancel while a query runs. Both labels are laid out on top of each
              other (one invisible), so the button keeps its width and nothing next to it moves. */}
          <Button
            onClick={run?.running ? cancel : () => void execute('auto')}
            size="sm"
            variant={run?.running ? 'destructive-outline' : 'default'}
          >
            <span className="grid *:col-start-1 *:row-start-1">
              <span className={cn('flex items-center gap-2', run?.running && 'invisible')}>
                <PlayIcon aria-hidden="true" className="fill-current" />
                Run
                <Kbd className="-me-1 bg-primary-foreground/15 text-primary-foreground/80">{shortcut('↵')}</Kbd>
              </span>
              <span className={cn('flex items-center justify-center gap-2', !run?.running && 'invisible')}>
                <SquareIcon aria-hidden="true" className="fill-current" />
                Cancel
              </span>
            </span>
          </Button>
          <GroupSeparator />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Run statement under cursor"
                  disabled={run?.running}
                  onClick={() => void execute('statement')}
                  size="sm"
                  variant="outline"
                />
              }
            >
              <TextCursorInputIcon aria-hidden="true" />
              <span className="max-md:hidden">Run statement</span>
            </TooltipTrigger>
            <TooltipPopup>Run the statement under the cursor ({shortcut('↵', { shift: true })})</TooltipPopup>
          </Tooltip>
        </ButtonGroup>
        <Tooltip>
          <TooltipTrigger render={<Button onClick={() => void format()} size="sm" variant="ghost" />}>
            <WandSparklesIcon aria-hidden="true" />
            <span className="max-md:hidden">Format</span>
          </TooltipTrigger>
          <TooltipPopup>Format SQL ({isMac ? '⇧⌥F' : 'Shift+Alt+F'})</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button onClick={save} size="sm" variant="ghost" />}>
            <SaveIcon aria-hidden="true" />
            <span className="max-md:hidden">Save</span>
          </TooltipTrigger>
          <TooltipPopup>Save query ({shortcut('S')})</TooltipPopup>
        </Tooltip>
        <HistoryPopover
          connectionId={connectionId}
          onPick={(sql) => {
            openTab(connectionId, sql)
          }}
        />
        <SavedQueriesPopover connectionId={connectionId} />
        <div className="ms-auto flex items-center gap-2 text-muted-foreground text-xs">
          <span className="max-sm:hidden">Row limit</span>
          <Select
            items={ROW_LIMITS.map((n) => ({ label: n.toLocaleString(), value: n }))}
            onValueChange={(v) => setMaxRows(v as number)}
            value={maxRows}
          >
            <SelectTrigger aria-label="Row limit" className="w-24 min-w-0" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {ROW_LIMITS.map((n) => (
                <SelectItem key={n} value={n}>
                  {n.toLocaleString()}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <SplitPane
        bottom={
          <div className="flex h-full min-h-0 flex-col">
            <ResultsPanel onCancel={cancel} state={run} tabName={active.name} />
          </div>
        }
        bottomLimits={{ min: 15, max: 100 }}
        className="min-h-0 flex-1"
        defaultTopSize={45}
        top={
          <div className="h-full min-h-0 overflow-hidden">
            <SqlEditor
              autoFocus
              defaultSchema="public"
              key={active.id}
              onChange={(value) => updateTab(connectionId, active.id, { sql: value })}
              onFormat={() => void format()}
              onRun={() => void execute('auto')}
              onRunStatement={() => void execute('statement')}
              ref={editorRef}
              schema={schema}
              value={active.sql}
            />
          </div>
        }
        topLimits={{ min: 15, max: 100 }}
      />

      <SaveQueryDialog
        connectionId={connectionId}
        database={database}
        onOpenChange={setSaveOpen}
        onSaved={(query) =>
          updateTab(connectionId, active.id, { savedId: query.id, savedSql: query.sql, name: query.name })
        }
        open={saveOpen}
        sql={active.sql}
      />
    </div>
  )
}

function TabStrip({
  tabs,
  activeId,
  runningIds,
  savedQueries,
  onSelect,
  onClose,
  onNew,
  onRename,
}: {
  tabs: SqlTab[]
  activeId: string
  runningIds: string[]
  savedQueries: SavedQuery[] | undefined
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onRename: (id: string, name: string) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <div className="flex items-center gap-1 border-b px-2">
      <Tabs className="min-w-0" onValueChange={(v) => onSelect(v as string)} value={activeId}>
        <TabsList className="no-scrollbar max-w-full justify-start overflow-x-auto" variant="underline">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId
            const running = runningIds.includes(tab.id)
            // a linked tab shows the saved name, and its text is compared with the saved SQL
            const linked = tab.savedId ? savedQueries?.find((q) => q.id === tab.savedId) : undefined
            const dirty = linked !== undefined && tab.sql !== tab.savedSql
            const title = linked?.name ?? tab.name
            return (
              <Tooltip key={tab.id}>
                <TooltipTrigger
                  render={
                    <TabsTab
                      aria-busy={running || undefined}
                      className="group/tab grow-0 gap-1 ps-2.5 pe-1 font-normal"
                      nativeButton={false}
                      onDoubleClick={() => {
                        if (!linked) setRenaming(tab.id)
                      }}
                      render={<div />}
                      value={tab.id}
                    />
                  }
                >
                  {renaming === tab.id ? (
                    <Input
                      aria-label="Tab name"
                      autoFocus
                      className="w-28"
                      defaultValue={tab.name}
                      onBlur={(e) => {
                        onRename(tab.id, e.currentTarget.value.trim() || tab.name)
                        setRenaming(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      size="sm"
                    />
                  ) : (
                    <span className="max-w-40 truncate">{title}</span>
                  )}
                  {dirty && (
                    <span
                      aria-label="Unsaved changes"
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                      role="img"
                    />
                  )}
                  {/* a running query shows a dot in the close button's slot (the X on hover), so the
                      title does not move when the query starts or ends */}
                  <Button
                    aria-label={`Close ${tab.name}`}
                    className={cn(!isActive && !running && 'opacity-0 group-hover/tab:opacity-100')}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(tab.id)
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    size="icon-xs"
                    variant="ghost"
                  >
                    {running && (
                      <span
                        aria-hidden="true"
                        className="size-1.5 animate-pulse rounded-full bg-success group-hover/tab:hidden"
                      />
                    )}
                    <XIcon className={cn(running && 'hidden group-hover/tab:block')} />
                  </Button>
                </TooltipTrigger>
                <TooltipPopup>
                  {linked ? 'Saved query. Rename it from the Saved menu.' : 'Double-click to rename'}
                </TooltipPopup>
              </Tooltip>
            )
          })}
        </TabsList>
      </Tabs>
      <Tooltip>
        <TooltipTrigger render={<Button aria-label="New tab" onClick={onNew} size="icon-xs" variant="ghost" />}>
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup>New query tab</TooltipPopup>
      </Tooltip>
    </div>
  )
}

function HistoryPopover({ connectionId, onPick }: { connectionId: string; onPick: (sql: string) => void }) {
  const history = useAppStore((s) => s.history[connectionId]) ?? []
  const clear = useAppStore((s) => s.clearHistory)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const items = history.filter((h) => !filter || h.sql.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Popover
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setFilter('')
      }}
      open={open}
    >
      <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
        <HistoryIcon aria-hidden="true" />
        <span className="max-md:hidden">History</span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-[min(34rem,calc(100vw-2rem))] *:data-[slot=popover-viewport]:py-0 *:data-[slot=popover-viewport]:[--viewport-inline-padding:0px]"
      >
        <div className="flex items-center gap-2 border-b p-2">
          <InputGroup className="flex-1">
            <InputGroupInput
              aria-label="Search history"
              autoFocus
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search history…"
              size="sm"
              value={filter}
            />
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
          </InputGroup>
          {history.length > 0 && (
            <Button onClick={() => clear(connectionId)} size="xs" variant="ghost">
              <Trash2Icon aria-hidden="true" />
              Clear
            </Button>
          )}
        </div>
        <div className="scrollbar-thin max-h-96 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-muted-foreground text-sm">
              {history.length ? 'No matches.' : 'Queries you run will appear here.'}
            </p>
          ) : (
            items.map((h) => (
              <Button
                className="h-auto w-full flex-col items-stretch gap-1 px-3 py-2 text-start font-normal"
                key={h.id}
                onClick={() => {
                  onPick(h.sql)
                  setOpen(false)
                }}
                variant="ghost"
              >
                <span className="line-clamp-2 break-all font-mono text-xs">{h.sql}</span>
                <span className="flex items-center gap-2 text-muted-foreground text-xs">
                  {h.ok ? (
                    <CheckIcon aria-hidden="true" className="size-3 text-success" />
                  ) : (
                    <CircleAlertIcon aria-hidden="true" className="size-3 text-destructive" />
                  )}
                  <span>{timeAgo(h.at)}</span>
                  <span>·</span>
                  <span>{formatDuration(h.durationMs)}</span>
                  <span>·</span>
                  <span className="truncate">{h.database}</span>
                  {!h.ok && h.error && <span className="truncate text-destructive-foreground">{h.error}</span>}
                </span>
              </Button>
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
