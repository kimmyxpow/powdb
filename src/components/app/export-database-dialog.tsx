import { useQuery } from '@tanstack/react-query'
import { DownloadIcon } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Radio, RadioGroup } from '@/components/ui/radio-group'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import {
  EXPORT_STATUS_PATH,
  PG_DUMP_MISSING_MESSAGE,
  databaseExportUrl,
  type DatabaseExportRequest,
  type ExportContent,
  type ExportFormat,
  type PgDumpStatus,
} from '@/lib/db-export'
import { useExportDatabaseDialog } from '@/lib/export-database-dialog'
import { allRelationsQuery, schemasQuery } from '@/lib/queries'
import type { RelationInfo } from '@/lib/types'
import { relationKindLabel } from '@/lib/format'

type Scope = 'database' | 'choose'

const CONTENT_OPTIONS: { value: ExportContent; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'schema', label: 'Structure only' },
  { value: 'data', label: 'Data only' },
]

/** Export a whole database, or chosen schemas and tables, as a pg_dump download. */
export function ExportDatabaseDialog({ connectionId, database }: { connectionId: string; database: string }) {
  const open = useExportDatabaseDialog((s) => s.open)
  const setOpen = useExportDatabaseDialog((s) => s.setOpen)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      {/* fixed height from the start: a scope change must not resize it, and the panel scrolls inside */}
      <DialogPopup className="sm:max-w-xl h-[min(48rem,calc(100dvh-2rem))] [&_[data-slot=scroll-area-content]]:h-full">
        {/* the form is unmounted when the dialog closes, so every open starts from the defaults */}
        {open && (
          <ExportForm
            key={`${connectionId}/${database}`}
            connectionId={connectionId}
            database={database}
            onDone={() => setOpen(false)}
          />
        )}
      </DialogPopup>
    </Dialog>
  )
}

async function fetchStatus(): Promise<PgDumpStatus> {
  const res = await fetch(EXPORT_STATUS_PATH, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `Could not check pg_dump (HTTP ${res.status}).`)
  }
  return (await res.json()) as PgDumpStatus
}

const relationKey = (r: Pick<RelationInfo, 'schema' | 'name'>) => JSON.stringify([r.schema, r.name])

function ExportForm({
  connectionId,
  database,
  onDone,
}: {
  connectionId: string
  database: string
  onDone: () => void
}) {
  const [content, setContent] = useState<ExportContent>('all')
  const [scope, setScope] = useState<Scope>('database')
  const [format, setFormat] = useState<ExportFormat>('sql')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const status = useQuery({
    queryKey: ['export-database', 'status'],
    queryFn: fetchStatus,
    staleTime: 0,
    retry: false,
  })
  const choosing = scope === 'choose'
  const schemas = useQuery({ ...schemasQuery(connectionId, database), enabled: choosing })
  const relations = useQuery({ ...allRelationsQuery(connectionId, database), enabled: choosing })

  const available = status.data?.available === true
  const missing = status.data?.available === false

  // Schemas shown in the list, with their tables and views (partition children follow their parent).
  const visibleSchemas = (schemas.data ?? []).filter((s) => !s.isSystem)
  const bySchema = new Map<string, RelationInfo[]>()
  for (const r of relations.data ?? []) {
    if (r.isPartition) continue
    const list = bySchema.get(r.schema) ?? []
    list.push(r)
    bySchema.set(r.schema, list)
  }

  const plan = buildSelection(
    visibleSchemas.map((s) => s.name),
    bySchema,
    selected,
  )
  const nothingChosen = choosing && selected.size === 0
  const canExport = available && !nothingChosen && !(choosing && (schemas.isPending || relations.isPending))

  const restoreHints: Record<ExportFormat, string> = {
    sql: `Restore into an empty database with: psql -d ${database} -f file.sql`,
    'sql-gz': `Restore into an empty database with: gunzip -c file.sql.gz | psql -d ${database}`,
    custom: `Restore into an empty database with: pg_restore -d ${database} file.dump`,
  }
  const restore = restoreHints[format]

  function toggleRelation(r: RelationInfo) {
    setSelected((prev) => {
      const next = new Set(prev)
      const key = relationKey(r)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSchema(tables: RelationInfo[]) {
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = tables.every((t) => next.has(relationKey(t)))
      for (const t of tables) {
        if (allOn) next.delete(relationKey(t))
        else next.add(relationKey(t))
      }
      return next
    })
  }

  function startExport() {
    const req: DatabaseExportRequest = { connection: connectionId, database, content, format }
    if (choosing) {
      if (plan.mode === 'schemas') req.schemas = plan.schemas
      else req.tables = plan.tables
    }
    const link = document.createElement('a')
    link.href = databaseExportUrl(req)
    // A new tab: a download closes it by itself, and an error shows as text without leaving this page.
    link.target = '_blank'
    link.rel = 'noopener'
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    onDone()
    toastManager.add({ type: 'info', title: 'Export started. Large databases can take a while.' })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Export database</DialogTitle>
        <DialogDescription>
          Download a backup of <span className="font-medium text-foreground">{database}</span>. Nothing on the server
          changes.
        </DialogDescription>
      </DialogHeader>

      <DialogPanel className="flex h-full flex-col gap-6">
        {missing ? (
          <Alert variant="error">
            <AlertDescription>{PG_DUMP_MISSING_MESSAGE}</AlertDescription>
          </Alert>
        ) : status.error ? (
          <Alert variant="error">
            <AlertDescription>{status.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium text-sm">What</legend>
          <SegmentedControl aria-label="What to export" role="radiogroup">
            {CONTENT_OPTIONS.map((o) => (
              <SegmentedControlItem
                aria-checked={content === o.value}
                data-checked={content === o.value ? '' : undefined}
                key={o.value}
                onClick={() => setContent(o.value)}
                role="radio"
              >
                {o.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium text-sm">Scope</legend>
          <RadioGroup onValueChange={(value) => setScope(value as Scope)} value={scope}>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="database" />
              Whole database
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="choose" />
              Choose schemas and tables
            </label>
          </RadioGroup>

          {choosing && (
            <div className="mt-2 rounded-lg border">
              {schemas.isPending || relations.isPending ? (
                <div className="flex flex-col gap-2 p-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ) : visibleSchemas.length === 0 ? (
                <p className="p-4 text-center text-muted-foreground text-sm">No schemas to choose from.</p>
              ) : (
                <ul className="flex flex-col">
                  {visibleSchemas.map((schema) => {
                    const tables = bySchema.get(schema.name) ?? []
                    const count = tables.filter((t) => selected.has(relationKey(t))).length
                    const all = tables.length > 0 && count === tables.length
                    return (
                      <li className="border-b last:border-b-0" key={schema.name}>
                        <label className="flex items-center gap-2 px-3 py-2 font-medium text-sm">
                          <Checkbox
                            aria-label={`Schema ${schema.name}`}
                            checked={all}
                            disabled={tables.length === 0}
                            indeterminate={count > 0 && !all}
                            onCheckedChange={() => toggleSchema(tables)}
                          />
                          <span className="truncate">{schema.name}</span>
                          <span className="ml-auto text-muted-foreground text-xs">
                            {tables.length === 0 ? 'no tables or views' : `${count}/${tables.length}`}
                          </span>
                        </label>
                        {tables.length > 0 && (
                          <ul className="flex flex-col pb-1 pl-8">
                            {tables.map((t) => (
                              <li key={t.oid}>
                                <label className="flex items-center gap-2 py-1 pr-3 text-sm">
                                  <Checkbox
                                    aria-label={`${schema.name}.${t.name}`}
                                    checked={selected.has(relationKey(t))}
                                    onCheckedChange={() => toggleRelation(t)}
                                  />
                                  <span className="truncate">{t.name}</span>
                                  <span className="ml-auto text-muted-foreground text-xs">
                                    {relationKindLabel(t.kind)}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
          {choosing && selected.size > 0 && (
            <p className="text-muted-foreground text-xs">
              {selected.size} {selected.size === 1 ? 'table or view' : 'tables and views'} selected.
              {plan.mode === 'tables' &&
                ' Functions, types and CREATE SCHEMA are left out when you pick individual tables.'}
            </p>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium text-sm">Format</legend>
          <RadioGroup onValueChange={(value) => setFormat(value as ExportFormat)} value={format}>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="sql" />
              SQL file (.sql)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="sql-gz" />
              Compressed SQL file (.sql.gz)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="custom" />
              pg_dump custom (.dump), for pg_restore
            </label>
          </RadioGroup>
          <p className="text-muted-foreground text-xs">{restore}</p>
        </fieldset>
      </DialogPanel>

      <DialogFooter>
        {/* which pg_dump runs, out of the way (always there, so the footer never shifts) */}
        <span className="min-h-4 self-center text-muted-foreground text-xs sm:me-auto">
          {available && status.data?.version ? `pg_dump ${status.data.version}` : ''}
        </span>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Tooltip>
          <TooltipTrigger
            render={
              // a disabled button gets no pointer events: the wrapper shows why
              <span className="inline-flex" />
            }
          >
            <Button disabled={!canExport} onClick={startExport}>
              <DownloadIcon aria-hidden="true" />
              Export
            </Button>
          </TooltipTrigger>
          {nothingChosen && <TooltipPopup>Pick at least one table</TooltipPopup>}
        </Tooltip>
      </DialogFooter>
    </>
  )
}

/**
 * What the selection turns into. Whole schemas go as `schemas`; any individual table makes it
 * `tables` (pg_dump ANDs the two, so they are never sent together). A schema counts as whole
 * when every table in it is selected, and then its tables are expanded when tables are sent.
 */
function buildSelection(
  schemaNames: string[],
  bySchema: Map<string, RelationInfo[]>,
  selected: Set<string>,
): { mode: 'schemas'; schemas: string[] } | { mode: 'tables'; tables: { schema: string; name: string }[] } {
  const wholeSchemas: string[] = []
  const tables: { schema: string; name: string }[] = []
  let partial = false
  for (const schema of schemaNames) {
    const rels = bySchema.get(schema) ?? []
    const chosen = rels.filter((r) => selected.has(relationKey(r)))
    if (chosen.length === 0) continue
    if (chosen.length === rels.length) wholeSchemas.push(schema)
    else partial = true
    for (const r of chosen) tables.push({ schema, name: r.name })
  }
  if (!partial) return { mode: 'schemas', schemas: wholeSchemas }
  return { mode: 'tables', tables }
}
