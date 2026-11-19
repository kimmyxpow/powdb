import { CheckIcon, CircleAlertIcon, CircleSlashIcon, CopyIcon, WandSparklesIcon } from 'lucide-react'
import { useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import { copyText } from '@/lib/export'
import { Kbd } from '@/components/ui/kbd'
import { shortcut } from '@/hooks/use-hotkey'
import { validateValue } from '@/lib/validate'
import {
  ArrayField,
  BooleanField,
  ForeignKeyField,
  TemporalField,
  columnSpec,
  isTemporal,
  localTimeHint,
  textToValue,
} from './value-editors'
import { cn } from '@/lib/utils'
import type { GridColumn, GridValue } from './types'
import { isDefaultMarker } from './types'

function initialText(value: GridValue | undefined, kind: GridColumn['kind']): string {
  if (value === undefined || value === null || isDefaultMarker(value)) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (kind === 'json') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return value
}

export interface ValueDialogState {
  rowId: string
  col: number
  value: GridValue | undefined
  /** text typed in the cell before the editor was expanded; shown instead of `value` */
  draft?: string
}

/** Large editor / viewer for a single value: the typed editor for its column (JSON, calendar, list, key search, …). */
export function ValueDialog({
  state,
  column,
  readOnly,
  isNew = false,
  onClose,
  onSave,
}: {
  state: ValueDialogState | null
  column: GridColumn | null
  readOnly: boolean
  /** the cell belongs to a new row (clearing it means DEFAULT) */
  isNew?: boolean
  onClose: () => void
  onSave: (value: GridValue) => void
}) {
  const [text, setText] = useState('')
  const [isNull, setIsNull] = useState(false)

  // Freeze what is shown while open: the parent clears `state` (and with it `column`/`readOnly`)
  // on close, but the dialog still animates out and must not change meanwhile.
  const current = { column, readOnly, isNew }
  const [kept, setKept] = useState(current)
  const changed = Boolean(state) && (column !== kept.column || readOnly !== kept.readOnly || isNew !== kept.isNew)
  if (changed) setKept(current)
  const { column: col, readOnly: isReadOnly, isNew: shownIsNew } = changed ? current : kept

  // Initialise before paint so the first frame already shows the right value. Runs when
  // `state` or `column` changes, like the effect it replaces, and also on mount: the
  // `null` start makes a dialog that mounts with a value initialise itself.
  const [initFor, setInitFor] = useState<{ state: ValueDialogState | null; column: GridColumn | null } | null>(null)
  if (initFor === null || initFor.state !== state || initFor.column !== column) {
    setInitFor({ state, column })
    if (state && column) {
      if (state.draft !== undefined) {
        setText(state.draft)
        setIsNull(false)
      } else {
        setText(initialText(state.value, column.kind))
        setIsNull(state.value === null)
      }
    }
  }

  if (!col) return null
  const staged: GridValue = isNull ? null : textToValue(text, col, shownIsNew)
  const problem = isReadOnly ? null : validateValue(staged, columnSpec(col), { isNew: shownIsNew })
  // store JSON as typed (PostgreSQL normalizes jsonb anyway)
  const save = () =>
    onSave(isNull ? null : col.kind === 'boolean' && text ? text === 'true' : textToValue(text, col, shownIsNew))
  const editText = (t: string) => {
    setText(t)
    setIsNull(false)
  }
  const hint = !problem && !isNull && text ? localTimeHint(text, col.kind, col.typeName) : null

  let editor: React.ReactNode
  if (!isReadOnly && col.kind === 'boolean') {
    editor = (
      <BooleanField
        nullable={col.nullable !== false}
        onChange={(v) => (v === null ? setIsNull(true) : editText(String(v)))}
        value={isNull ? null : text === '' ? undefined : text === 'true'}
      />
    )
  } else if (!isReadOnly && col.kind === 'array') {
    editor = (
      <ArrayField
        onChange={(literal) => (literal === null ? setIsNull(true) : editText(literal))}
        onCommit={(literal) => (literal === null ? setIsNull(true) : editText(literal))}
        typeName={col.typeName}
        value={isNull ? null : text}
      />
    )
  } else if (!isReadOnly && isTemporal(col.kind)) {
    editor = (
      <TemporalField
        autoFocus
        inline
        invalid={Boolean(problem)}
        kind={col.kind}
        onChange={editText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          }
        }}
        placeholder={isNull ? 'NULL' : undefined}
        size="default"
        typeName={col.typeName}
        value={isNull ? '' : text}
      />
    )
  } else if (!isReadOnly && col.foreignKey) {
    editor = (
      <ForeignKeyField
        autoFocus
        fk={col.foreignKey}
        invalid={Boolean(problem)}
        onChange={editText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
        placeholder={isNull ? 'NULL' : `Search ${col.foreignKey.table} by ${col.foreignKey.column} or name…`}
        size="default"
        value={isNull ? '' : text}
      />
    )
  } else {
    editor = (
      <Textarea
        aria-invalid={Boolean(problem) || undefined}
        autoFocus
        className="font-mono text-[13px] *:data-[slot=textarea]:max-h-[55vh] *:data-[slot=textarea]:min-h-64"
        disabled={isNull && !isReadOnly}
        onChange={(e) => editText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isReadOnly) {
            e.preventDefault()
            save()
          }
        }}
        placeholder={isNull ? 'NULL' : ''}
        readOnly={isReadOnly}
        rows={14}
        spellCheck={false}
        value={isNull && isReadOnly ? 'NULL' : text}
      />
    )
  }

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={Boolean(state)}>
      <DialogPopup
        // compact editors (calendar, true/false) get a compact dialog, so they sit balanced in it
        className={!isReadOnly && (isTemporal(col.kind) || col.kind === 'boolean') ? 'sm:max-w-sm' : 'sm:max-w-2xl'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isReadOnly && !e.defaultPrevented) {
            e.preventDefault()
            save()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-base">
            {col.name}
            <Badge className="font-normal" variant="outline">
              {col.typeName}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {isReadOnly ? 'Full value of this cell.' : 'Your change is kept with the others until you save the table.'}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {editor}
          {!isReadOnly && (
            // one reserved line (long messages are cut, full text on hover), so the status
            // never resizes the dialog
            <p
              aria-live="polite"
              className={cn(
                'flex h-4 min-w-0 items-center gap-1.5 text-xs',
                problem ? 'text-destructive-foreground' : 'text-muted-foreground',
              )}
              title={problem ?? hint ?? undefined}
            >
              {problem ? (
                <>
                  <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{problem}</span>
                </>
              ) : hint ? (
                <span className="truncate">{hint}</span>
              ) : !isNull && text.trim() && col.kind !== 'text' && col.kind !== 'other' && col.kind !== 'boolean' ? (
                <>
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  {col.kind === 'json' ? 'Valid JSON' : `Valid ${col.typeName}`}
                </>
              ) : null}
            </p>
          )}
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button
              onClick={() => {
                void copyText(isNull ? '' : text)
                toastManager.add({ title: 'Value copied', timeout: 1500 })
              }}
              size="sm"
              variant="ghost"
            >
              <CopyIcon aria-hidden="true" />
              Copy
            </Button>
            {col.kind === 'json' && !isReadOnly && (
              <Button
                disabled={Boolean(problem) || isNull || !text.trim()}
                onClick={() => setText(JSON.stringify(JSON.parse(text), null, 2))}
                size="sm"
                variant="ghost"
              >
                <WandSparklesIcon aria-hidden="true" />
                Format
              </Button>
            )}
            {!isReadOnly && col.nullable && col.kind !== 'boolean' && (
              <Button onClick={() => setIsNull((v) => !v)} size="sm" variant="ghost">
                <CircleSlashIcon aria-hidden="true" />
                {isNull ? 'Unset NULL' : 'Set NULL'}
              </Button>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <DialogClose render={<Button variant="ghost" />}>{isReadOnly ? 'Close' : 'Cancel'}</DialogClose>
            {!isReadOnly && (
              <Button onClick={save}>
                Apply
                <Kbd className="-me-1 bg-primary-foreground/15 text-primary-foreground/80">{shortcut('↵')}</Kbd>
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
