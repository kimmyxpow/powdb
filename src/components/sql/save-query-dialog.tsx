import type { FormEvent } from 'react'
import { useState } from 'react'
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toastManager } from '@/components/ui/toast'
import { useCreateSavedQuery, suggestSavedName } from '@/lib/saved-queries'
import type { SavedQuery } from '@/lib/types'

/** Saves the editor text as a new saved query. The caller links the tab to it. */
export function SaveQueryDialog({
  open,
  onOpenChange,
  connectionId,
  database,
  sql,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  database: string
  sql: string
  onSaved: (query: SavedQuery) => void
}) {
  const [name, setName] = useState('')
  const [everywhere, setEverywhere] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = useCreateSavedQuery()

  const [shownFor, setShownFor] = useState<string | null>(null)
  const key = open ? sql : null
  if (key !== shownFor) {
    setShownFor(key)
    if (open) {
      setName(suggestSavedName(sql))
      setEverywhere(false)
      setError(null)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return setError('Give the query a name.')
    setError(null)
    // computed before the try: the React Compiler cannot compile conditionals inside a try block
    const scopeConnectionId = everywhere ? null : connectionId
    try {
      const query = await create.mutateAsync({
        name: trimmed,
        sql,
        connectionId: scopeConnectionId,
        database,
      })
      onSaved(query)
      onOpenChange(false)
      toastManager.add({ type: 'success', title: 'Saved', timeout: 1500 })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-md">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Save query</DialogTitle>
            <DialogDescription>Saved queries are listed in the Saved menu of the SQL editor.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            <Field>
              <FieldLabel htmlFor="saved-query-name">Name</FieldLabel>
              <Input
                autoFocus
                id="saved-query-name"
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                value={name}
              />
              {error && <FieldDescription className="text-destructive-foreground">{error}</FieldDescription>}
            </Field>
            <Field>
              <div className="flex w-full items-center justify-between gap-4">
                <FieldLabel htmlFor="saved-query-everywhere">Show for every connection</FieldLabel>
                <Switch checked={everywhere} id="saved-query-everywhere" onCheckedChange={setEverywhere} />
              </div>
              <FieldDescription>
                {everywhere ? 'Listed on every connection in pow/view.' : 'Listed only on this connection.'}
              </FieldDescription>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!name.trim()} loading={create.isPending} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
