import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, FileTextIcon, UploadIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CopyButton } from '@/components/app/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { toastManager } from '@/components/ui/toast'
import {
  RESTORE_FORMAT_LABELS,
  RESTORE_SNIFF_BYTES,
  detectRestoreFormat,
  restoreUrl,
  type RestoreFormat,
  type RestoreRequest,
  type RestoreResult,
} from '@/lib/db-restore'
import { countLabel, formatBytes } from '@/lib/format'
import { keys } from '@/lib/queries'
import { useRestoreDatabaseDialog } from '@/lib/restore-database-dialog'
import { cn } from '@/lib/utils'

/** Names the picker and the drop zone take. The format itself is read from the file's first bytes. */
const ACCEPTED_NAME = /\.(sql|gz|dump|backup)$/i

type RestoreReply = Partial<RestoreResult> & { error?: { message?: string } }

/** A restore that failed (422 or a network error). Carries the tool's log when there is one. */
class RestoreError extends Error {
  readonly log: string
  constructor(message: string, log: string) {
    super(message)
    this.name = 'RestoreError'
    this.log = log
  }
}

/**
 * Sends the file as the raw body and reports the upload progress. XMLHttpRequest, because fetch
 * cannot report how much of a request body has been sent.
 */
function sendRestore(
  url: string,
  file: File,
  on: { onProgress: (percent: number) => void; onUploaded: () => void },
): Promise<RestoreResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) on.onProgress(Math.floor((e.loaded / e.total) * 100))
    }
    xhr.upload.onload = () => {
      on.onProgress(100)
      on.onUploaded()
    }
    xhr.onload = () => {
      let body: RestoreReply | null = null
      try {
        body = JSON.parse(xhr.responseText) as RestoreReply
      } catch {
        body = null
      }
      if (xhr.status === 200 && body) {
        resolve(body as RestoreResult)
        return
      }
      reject(new RestoreError(body?.error?.message ?? `Restore failed (${xhr.status}).`, body?.log ?? ''))
    }
    xhr.onerror = () => reject(new RestoreError('Could not reach pow/view.', ''))
    xhr.send(file)
  })
}

export function RestoreDatabaseDialog({
  connectionId,
  connectionName,
  database,
  production,
  readOnly,
}: {
  connectionId: string
  connectionName: string
  database: string
  production: boolean
  readOnly: boolean
}) {
  const open = useRestoreDatabaseDialog((s) => s.open)
  const setOpen = useRestoreDatabaseDialog((s) => s.setOpen)
  // the form reports whether a restore is running, so the dialog cannot be closed meanwhile
  const [running, setRunning] = useState(false)
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && running) return
        setOpen(next)
      }}
      open={open}
    >
      <DialogPopup className="sm:max-w-2xl" showCloseButton={!running}>
        {/* the form is unmounted when the dialog closes, so every open starts from the defaults */}
        {open && (
          <RestoreForm
            key={`${connectionId}/${database}`}
            connectionId={connectionId}
            connectionName={connectionName}
            database={database}
            onBusyChange={setRunning}
            onDone={() => setOpen(false)}
            production={production}
            readOnly={readOnly}
          />
        )}
      </DialogPopup>
    </Dialog>
  )
}

function RestoreForm({
  connectionId,
  connectionName,
  database,
  production,
  readOnly,
  onBusyChange,
  onDone,
}: {
  connectionId: string
  connectionName: string
  database: string
  production: boolean
  readOnly: boolean
  onBusyChange: (busy: boolean) => void
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  // the sniffed format is kept with the file it belongs to, so a stale result never applies to a new file
  const [detected, setDetected] = useState<{ file: File; format: RestoreFormat } | null>(null)
  const format = detected && detected.file === file ? detected.format : null
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [atomic, setAtomic] = useState(true)
  const [clean, setClean] = useState(false)
  const [typed, setTyped] = useState('')
  const [percent, setPercent] = useState(0)
  const [uploaded, setUploaded] = useState(false)

  const restore = useMutation({
    mutationFn: async ({ file: body, req }: { file: File; req: RestoreRequest }) => {
      setPercent(0)
      setUploaded(false)
      return sendRestore(restoreUrl(req), body, {
        onProgress: setPercent,
        onUploaded: () => setUploaded(true),
      })
    },
    onSuccess: (result) => {
      if (result.errors === 0) {
        toastManager.add({ type: 'success', title: 'Restore finished' })
        onDone()
      }
    },
    // partial changes are possible even when the restore failed, so the cache is always refreshed
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.db(connectionId, database) })
    },
  })
  const running = restore.isPending
  useEffect(() => {
    onBusyChange(running)
    // gone while running (another database): the dialog is not busy any more
    return () => onBusyChange(false)
  }, [running, onBusyChange])

  // the format comes from the first bytes, not from the name
  useEffect(() => {
    if (!file) return
    let cancelled = false
    file
      .slice(0, RESTORE_SNIFF_BYTES)
      .arrayBuffer()
      .then(
        (buffer) => {
          if (!cancelled) setDetected({ file, format: detectRestoreFormat(new Uint8Array(buffer)) })
        },
        () => {
          if (!cancelled) setFileError('Could not read this file.')
        },
      )
    return () => {
      cancelled = true
    }
  }, [file])

  const pick = (picked: File) => {
    if (!ACCEPTED_NAME.test(picked.name)) {
      setFileError('Choose a .sql, .sql.gz, .dump or .backup file.')
      return
    }
    setFileError(null)
    restore.reset()
    setFile(picked)
  }

  const result = restore.data ?? null
  // a run that finished with errors stays on screen; the user closes it themselves
  const finishedWithErrors = result !== null && result.errors > 0
  const failure = restore.error instanceof RestoreError ? restore.error : null
  const canRestore =
    !readOnly && file !== null && format !== null && typed === database && !running && !finishedWithErrors

  const submit = () => {
    if (!file || !format || !canRestore) return
    restore.mutate({
      file,
      req: {
        connection: connectionId,
        database,
        format,
        atomic,
        clean: format === 'custom' && clean,
      },
    })
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          <span>Restore into {database}</span>
          {production && <Badge variant="destructive">Production</Badge>}
        </DialogTitle>
        <DialogDescription>
          Runs a backup file against this database. Use an empty database unless the file was made to replace what is
          there.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        {readOnly && (
          <Alert variant="error">
            <CircleAlertIcon />
            <AlertDescription>This connection is read-only.</AlertDescription>
          </Alert>
        )}

        {!file ? (
          <button
            className={cn(
              'flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64',
              dragging && 'border-primary bg-accent/40',
            )}
            disabled={running || readOnly}
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
              if (dropped && !running && !readOnly) pick(dropped)
            }}
            type="button"
          >
            <UploadIcon aria-hidden="true" className="size-5 text-muted-foreground" />
            <span className="font-medium text-sm">Drop a backup file here, or click to choose one</span>
            <span className="text-muted-foreground text-xs">.sql, .sql.gz, .dump or .backup</span>
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
            <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{file.name}</div>
              <div className="flex items-center gap-2 text-muted-foreground text-xs tabular-nums">
                <span>{formatBytes(file.size)}</span>
                {format && <Badge variant="outline">{RESTORE_FORMAT_LABELS[format]}</Badge>}
              </div>
            </div>
            <Button
              disabled={running || readOnly}
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
          accept=".sql,.gz,.dump,.backup"
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

        {file && format && (
          <>
            <div className="flex flex-col gap-4">
              <label className="flex items-start gap-3">
                <Switch checked={atomic} disabled={running} onCheckedChange={setAtomic} />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-sm">All or nothing</span>
                  <span className="text-muted-foreground text-xs">Stops at the first error and undoes everything.</span>
                </span>
              </label>
              {format === 'custom' && (
                <label className="flex items-start gap-3">
                  <Switch checked={clean} disabled={running} onCheckedChange={setClean} />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-sm">Drop existing objects first</span>
                    <span className="text-muted-foreground text-xs">
                      Drops each object before recreating it. Use this to replace a database&apos;s contents.
                    </span>
                  </span>
                </label>
              )}
            </div>

            <Alert variant="warning">
              <CircleAlertIcon />
              <AlertDescription>
                This changes {database} on {connectionName}. Make an export first if you might need to undo it.
                {production && <span className="mt-1 block">This connection is marked as production.</span>}
              </AlertDescription>
            </Alert>

            <Field>
              <FieldLabel className="font-normal text-muted-foreground">
                Type <span className="font-medium font-mono text-foreground">{database}</span> to confirm
              </FieldLabel>
              <Input
                autoComplete="off"
                disabled={running}
                onChange={(e) => setTyped(e.target.value)}
                spellCheck={false}
                value={typed}
              />
            </Field>
          </>
        )}

        {running &&
          (uploaded ? (
            <div className="flex items-center gap-2 text-sm">
              <Spinner />
              Restoring…
            </div>
          ) : (
            <Progress value={percent}>
              <ProgressLabel>{`Uploading ${percent}%`}</ProgressLabel>
              <ProgressTrack>
                <ProgressIndicator />
              </ProgressTrack>
            </Progress>
          ))}

        {finishedWithErrors && result && (
          <>
            <Alert variant="warning">
              <CircleAlertIcon />
              <AlertTitle>{`Finished with ${countLabel(result.errors, 'error')}`}</AlertTitle>
              <AlertDescription>
                Statements that failed were skipped; everything else ran. Check the log below.
              </AlertDescription>
            </Alert>
            <RestoreLog log={result.log} />
          </>
        )}

        {failure && (
          <>
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertTitle>Restore failed</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap break-words">{failure.message}</AlertDescription>
            </Alert>
            <RestoreLog log={failure.log} />
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button disabled={running} type="button" variant="ghost" />}>
          {finishedWithErrors ? 'Close' : 'Cancel'}
        </DialogClose>
        {!finishedWithErrors && (
          <Button disabled={!canRestore} loading={running} type="submit" variant="destructive">
            Restore
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}

function RestoreLog({ log }: { log: string }) {
  if (!log) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">Log</span>
        <CopyButton label="Copy log" text={log}>
          Copy log
        </CopyButton>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-xs">
        {log}
      </pre>
    </div>
  )
}
