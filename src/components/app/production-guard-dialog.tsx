import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useRetained } from '@/hooks/use-retained'
import { useProductionGuardStore } from '@/lib/production-guard'

/** Asks before a change on a production connection. Enter confirms when the button is enabled; Escape cancels. */
export function ProductionGuardDialog() {
  const pending = useProductionGuardStore((s) => s.pending)
  const settle = useProductionGuardStore((s) => s.settle)
  const prompt = useRetained(pending?.prompt ?? null)
  // the typed text belongs to one request: a new request (even while the dialog is open) starts empty
  const [typedFor, setTypedFor] = useState<{ prompt: unknown; text: string }>({ prompt: null, text: '' })
  const typed = typedFor.prompt === prompt ? typedFor.text : ''
  const setTyped = (text: string) => setTypedFor({ prompt, text })
  const open = pending !== null
  const blocked = Boolean(prompt?.destructive) && typed !== prompt?.database

  const confirm = () => {
    if (open && !blocked) settle(true)
  }

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) settle(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setTyped('')
      }}
      open={open}
    >
      <AlertDialogPopup
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.defaultPrevented) return
          // a focused button handles Enter itself (Cancel closes, the confirm button clicks)
          if (e.target instanceof HTMLButtonElement) return
          e.preventDefault()
          confirm()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex flex-wrap items-center gap-2">
            <span>Change {prompt?.connectionName}?</span>
            <Badge variant="destructive">Production</Badge>
          </AlertDialogTitle>
          <AlertDialogDescription>This connection is marked as production.</AlertDialogDescription>
        </AlertDialogHeader>
        {prompt && (
          <div className="flex min-w-0 flex-col gap-3 px-6 pb-4">
            <div className="flex flex-col gap-1">
              <p className="font-medium text-sm">{prompt.action}</p>
              {prompt.detail && <p className="text-muted-foreground text-xs">{prompt.detail}</p>}
            </div>
            {prompt.sql && (
              <pre className="max-h-48 overflow-auto whitespace-pre rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                {prompt.sql}
              </pre>
            )}
            {prompt.destructive && (
              <Field>
                <FieldLabel className="font-normal text-muted-foreground">
                  Type <span className="font-medium font-mono text-foreground">{prompt.database}</span> to confirm
                </FieldLabel>
                <Input autoFocus onChange={(e) => setTyped(e.target.value)} spellCheck={false} value={typed} />
              </Field>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button disabled={blocked} onClick={confirm} variant="destructive">
            {prompt?.confirmLabel ?? 'Run on production'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
