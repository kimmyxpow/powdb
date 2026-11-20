import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, FileTextIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { detectDelimiter, parseCsv } from '@/lib/csv'
import { countLabel, formatBytes } from '@/lib/format'
import { useProductionGuard } from '@/lib/production-guard'
import { keys } from '@/lib/queries'
import type { ColumnInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Only this much of the file is read in the browser, for the preview and the column list. */
const SAMPLE_BYTES = 64 * 1024
const PREVIEW_ROWS = 5

type Delimiter = 'auto' | ',' | ';' | '\t' | '|'
const DELIMITERS: { value: Delimiter; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe' },
]

/** A CSV column index, or 'skip' (the column takes its default). */
type Choice = number | 'skip'

/** Identity ALWAYS and generated columns are filled by the database. */
const isGenerated = (c: ColumnInfo) => c.identity === 'a' || c.generated !== ''

/** Names match when they are equal ignoring case, underscores, dashes and spaces. */
const normName = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '')

interface Sample {
  text: string
  truncated: boolean
}

export function ImportCsvDialog({
  open,
  onOpenChange,
  connectionId,
  database,
  schema,
  table,
  columns,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  database: string
  schema: string
  table: string
  columns: ColumnInfo[]
}) {
  const queryClient = useQueryClient()
  const guard = useProductionGuard(connectionId, database)
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [header, setHeader] = useState(true)
  const [delimiterChoice, setDelimiterChoice] = useState<Delimiter>('auto')
  const [nullEmpty, setNullEmpty] = useState(true)
  /** the user's column choices; anything not here follows the automatic match */
  const [overrides, setOverrides] = useState<Record<string, Choice>>({})

  /** the upload in flight, aborted when the dialog unmounts (navigation away) */
  const uploadRef = useRef<AbortController | null>(null)
  useEffect(() => () => uploadRef.current?.abort(), [])

  const importMutation = useMutation({
    mutationFn: async (body: File) => {
      const controller = new AbortController()
      uploadRef.current = controller
      const params = new URLSearchParams({
        connection: connectionId,
        database,
        schema,
        table,
        header: header ? '1' : '0',
        nullEmpty: nullEmpty ? '1' : '0',
        mapping: JSON.stringify(mapping),
      })
      if (delimiterChoice !== 'auto') params.set('delimiter', delimiterChoice)
      const res = await fetch(`/api/import/csv?${params.toString()}`, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        signal: controller.signal,
      })
      const data: unknown = await res.json().catch(() => null)
      // The dialog went away meanwhile: its result is dropped, so no toast and no state change.
      if (controller.signal.aborted) throw new DOMException('The import was cancelled.', 'AbortError')
      if (!res.ok) {
        const message = (data as { error?: { message?: string } } | null)?.error?.message
        throw new Error(message ?? `Import failed (${res.status}).`)
      }
      return data as { inserted: number }
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: keys.relation(connectionId, database, schema, table) })
      void queryClient.invalidateQueries({ queryKey: [...keys.db(connectionId, database), 'objects'] })
      toastManager.add({
        type: 'success',
        title: `Imported ${countLabel(data.inserted, 'row')} into ${table}.`,
      })
      onOpenChange(false)
    },
  })
  const running = importMutation.isPending

  // a fresh dialog each time it opens (the mutation is reset in onOpenChangeComplete)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setFile(null)
      setFileError(null)
      setHeader(true)
      setDelimiterChoice('auto')
      setNullEmpty(true)
      setOverrides({})
    }
  }

  // read only the start of the file; the sample is kept with the file it was read from
  const [loaded, setLoaded] = useState<{ file: File; sample: Sample } | null>(null)
  const sample = loaded && loaded.file === file ? loaded.sample : null
  useEffect(() => {
    if (!file) return
    let cancelled = false
    file
      .slice(0, SAMPLE_BYTES)
      .text()
      .then(
        (text) => {
          if (!cancelled) setLoaded({ file, sample: { text, truncated: file.size > SAMPLE_BYTES } })
        },
        () => {
          if (!cancelled) setFileError('Could not read this file.')
        },
      )
    return () => {
      cancelled = true
    }
  }, [file])

  const delimiter = delimiterChoice === 'auto' ? detectDelimiter(sample?.text ?? '') : delimiterChoice

  // the sample's records; the last one is dropped when the sample ends in the middle of the file
  const parsed = sample ? parseCsv(sample.text, delimiter) : []
  const rows = sample?.truncated ? parsed.slice(0, -1) : parsed

  const width = rows.reduce((max, r) => Math.max(max, r.length), 0)
  const headerRow = header ? (rows[0] ?? []) : []
  const dataRows = rows.slice(header ? 1 : 0)
  const sourceLabels = Array.from({ length: width }, (_, i) => headerRow[i]?.trim() || `Column ${i + 1}`)
  const sourceItems = [
    { value: 'skip', label: 'Skip (use default)' },
    ...sourceLabels.map((label, i) => ({ value: String(i), label })),
  ]

  // the columns matched to the header row by name (none without a header row)
  const autoMatch: Record<string, number> = {}
  if (header) {
    const firstRecord = rows[0] ?? []
    const used = new Set<number>()
    for (const c of columns) {
      if (isGenerated(c)) continue
      const key = normName(c.name)
      if (!key) continue
      const index = firstRecord.findIndex((h, i) => !used.has(i) && normName(h) === key)
      if (index >= 0) {
        autoMatch[c.name] = index
        used.add(index)
      }
    }
  }

  const choiceOf = (name: string): Choice => overrides[name] ?? autoMatch[name] ?? 'skip'

  const mapping = columns
    .filter((c) => !isGenerated(c))
    .flatMap((c) => {
      const choice = choiceOf(c.name)
      return choice === 'skip' ? [] : [{ column: c.name, source: choice }]
    })

  const requiredMissing = columns.filter(
    (c) =>
      !isGenerated(c) && c.identity === '' && !c.nullable && c.defaultValue === null && choiceOf(c.name) === 'skip',
  )

  // why the import cannot run yet: shown above the column list and on the Import button
  const blockers =
    requiredMissing.length > 0
      ? requiredMissing.map((c) => `${c.name} is required and has no default.`)
      : mapping.length === 0
        ? ['Map at least one column.']
        : []
  const blocked = !file ? 'Choose a file first' : !sample ? 'Reading the file' : (blockers[0] ?? null)

  const pick = (picked: File) => {
    if (!/\.(csv|tsv|txt)$/i.test(picked.name) && !picked.type.startsWith('text/')) {
      setFileError('Choose a .csv, .tsv or .txt file.')
      return
    }
    setFileError(null)
    setOverrides({})
    importMutation.reset()
    setFile(picked)
  }

  const submit = () => {
    if (!file || blocked || running) return
    void guard({ action: `Import ${file.name} into ${schema}.${table}`, confirmLabel: 'Import on production' }).then(
      (ok) => {
        if (ok) importMutation.mutate(file)
      },
    )
  }

  const handleOpenChange = (next: boolean) => {
    // a running import must finish: no closing by Escape, outside click or the X
    if (!next && running) return
    onOpenChange(next)
  }

  const previewCount = Math.min(PREVIEW_ROWS, dataRows.length)

  return (
    <Dialog
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) importMutation.reset()
      }}
      open={open}
    >
      {/* fixed height from the start (the import preview grows to this size): the panel scrolls inside */}
      <DialogPopup
        className="sm:max-w-2xl h-[min(48rem,calc(100dvh-2rem))] [&_[data-slot=scroll-area-content]]:h-full"
        showCloseButton={!running}
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>Import CSV</DialogTitle>
            <DialogDescription>
              Add rows from a CSV file to {schema}.{table}. Nothing is saved unless every row goes in.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex h-full flex-col gap-5">
            {!file ? (
              <div className="flex flex-1 flex-col justify-center">
                <button
                  className={cn(
                    'flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring',
                    dragging && 'border-primary bg-accent/40',
                  )}
                  disabled={running}
                  onClick={() => inputRef.current?.click()}
                  onDragLeave={() => setDragging(false)}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    const dropped = e.dataTransfer.files[0]
                    if (dropped) pick(dropped)
                  }}
                  type="button"
                >
                  <span className="font-medium text-sm">Drop a CSV file here, or click to choose one</span>
                  <span className="text-muted-foreground text-xs">.csv, .tsv or .txt</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
                <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-sm">{file.name}</div>
                  <div className="text-muted-foreground text-xs tabular-nums">{formatBytes(file.size)}</div>
                </div>
                <Button
                  disabled={running}
                  onClick={() => inputRef.current?.click()}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  Choose another file
                </Button>
              </div>
            )}
            <input
              accept=".csv,.tsv,.txt,text/csv"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0]
                e.target.value = ''
                if (picked) pick(picked)
              }}
              ref={inputRef}
              tabIndex={-1}
              type="file"
            />
            {fileError && <p className="text-destructive text-sm">{fileError}</p>}

            {file && (
              <>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={header}
                      disabled={running}
                      onCheckedChange={(v) => {
                        setHeader(v)
                        setOverrides({})
                      }}
                    />
                    First row is a header
                  </label>
                  <div className="flex items-center gap-2 text-sm">
                    <span>Delimiter</span>
                    <Select
                      disabled={running}
                      onValueChange={(v) => {
                        if (!v) return
                        setDelimiterChoice(v as Delimiter)
                        setOverrides({})
                      }}
                      items={DELIMITERS}
                      value={delimiterChoice}
                    >
                      <SelectTrigger aria-label="Delimiter" className="w-36" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {DELIMITERS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={nullEmpty} disabled={running} onCheckedChange={setNullEmpty} />
                    Empty cells become NULL
                  </label>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-xs">
                    {dataRows.length > 0 ? `Preview, first ${previewCount} rows` : 'Preview'}
                  </span>
                  {!sample ? (
                    <div className="flex items-center gap-2 text-muted-foreground text-sm">
                      <Spinner />
                      Reading the file…
                    </div>
                  ) : width === 0 || dataRows.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No data rows found in this file.</p>
                  ) : (
                    <div className="max-h-56 overflow-auto rounded-lg border">
                      <Table className="text-[13px]">
                        <TableHeader>
                          <TableRow>
                            {sourceLabels.map((label, i) => (
                              <TableHead className="max-w-48 truncate font-mono" key={i}>
                                {label}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {dataRows.slice(0, PREVIEW_ROWS).map((row, r) => (
                            <TableRow key={r}>
                              {sourceLabels.map((_, i) => {
                                const value = row[i] ?? ''
                                return (
                                  <TableCell className="max-w-48 truncate font-mono" key={i} title={value}>
                                    {value === '' && nullEmpty ? (
                                      <span className="text-muted-foreground italic">NULL</span>
                                    ) : (
                                      value
                                    )}
                                  </TableCell>
                                )
                              })}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>

                {sample && blockers.length > 0 && (
                  <Alert variant="warning">
                    <CircleAlertIcon />
                    <AlertDescription>
                      {blockers.map((b) => (
                        <div key={b}>{b}</div>
                      ))}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs">Columns</span>
                  <div className="flex flex-col divide-y rounded-lg border">
                    {columns.map((c) => (
                      <div
                        className="grid grid-cols-[minmax(0,1fr)_minmax(0,15rem)] items-center gap-3 px-3 py-2"
                        key={c.name}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[13px]">{c.name}</div>
                          <div className="truncate text-muted-foreground text-xs">{c.type}</div>
                        </div>
                        {isGenerated(c) ? (
                          <span className="text-muted-foreground text-xs">Generated, filled by the database</span>
                        ) : (
                          <Select
                            disabled={running || sourceLabels.length === 0}
                            onValueChange={(v) => {
                              if (v === null) return
                              setOverrides((prev) => ({ ...prev, [c.name]: v === 'skip' ? 'skip' : Number(v) }))
                            }}
                            items={sourceItems}
                            value={String(choiceOf(c.name))}
                          >
                            <SelectTrigger aria-label={`CSV column for ${c.name}`} className="min-w-0" size="sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup alignItemWithTrigger={false}>
                              {sourceItems.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {importMutation.error && (
                  <Alert variant="error">
                    <CircleAlertIcon />
                    <AlertTitle>Nothing was imported</AlertTitle>
                    <AlertDescription className="whitespace-pre-wrap break-words">
                      {importMutation.error.message}
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button disabled={running} type="button" variant="ghost" />}>Cancel</DialogClose>
            <Tooltip>
              <TooltipTrigger
                render={
                  // a disabled button gets no pointer events: the wrapper shows why
                  <span className="inline-flex" />
                }
              >
                <Button disabled={Boolean(blocked) || running} type="submit">
                  {running ? (
                    <>
                      <Spinner />
                      Importing…
                    </>
                  ) : (
                    'Import rows'
                  )}
                </Button>
              </TooltipTrigger>
              {blocked && !running && <TooltipPopup>{blocked}</TooltipPopup>}
            </Tooltip>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
