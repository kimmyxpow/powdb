import { useQuery } from '@tanstack/react-query'
import { BookmarkIcon, EllipsisIcon, PencilIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Input } from '@/components/ui/input'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { toastManager } from '@/components/ui/toast'
import { shortcut } from '@/hooks/use-hotkey'
import { timeAgo } from '@/lib/format'
import { firstLine, savedQueriesQuery, useDeleteSavedQuery, useUpdateSavedQuery } from '@/lib/saved-queries'
import { useAppStore } from '@/lib/store'
import type { SavedQuery } from '@/lib/types'

/** Toolbar button that lists the saved queries. Opening one switches to its linked tab or opens a new one. */
export function SavedQueriesPopover({ connectionId }: { connectionId: string }) {
  const { data: saved } = useQuery(savedQueriesQuery(connectionId))
  const openSaved = useAppStore((s) => s.openSavedQuery)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  // Rename and delete live outside the popover, so they stay open when the popover closes.
  const [renaming, setRenaming] = useState<SavedQuery | null>(null)
  const [deleting, setDeleting] = useState<SavedQuery | null>(null)
  const remove = useDeleteSavedQuery()

  const list = saved ?? []
  const q = filter.trim().toLowerCase()
  const items = q ? list.filter((x) => x.name.toLowerCase().includes(q) || x.sql.toLowerCase().includes(q)) : list

  return (
    <>
      <Popover
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen) setFilter('')
        }}
        open={open}
      >
        <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
          <BookmarkIcon aria-hidden="true" />
          <span className="max-md:hidden">Saved</span>
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          className="w-[min(34rem,calc(100vw-2rem))] *:data-[slot=popover-viewport]:py-0 *:data-[slot=popover-viewport]:[--viewport-inline-padding:0px]"
        >
          <div className="flex items-center gap-2 border-b p-2">
            <InputGroup className="flex-1">
              <InputGroupInput
                aria-label="Search saved queries"
                autoFocus
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search saved queries…"
                size="sm"
                value={filter}
              />
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
            </InputGroup>
          </div>
          <div className="scrollbar-thin max-h-96 overflow-y-auto p-1.5">
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-muted-foreground text-sm">
                {list.length
                  ? 'No matches.'
                  : `No saved queries yet. Press ${shortcut('S')} in the editor to save one.`}
              </p>
            ) : (
              items.map((query) => (
                <div className="flex items-center gap-1" key={query.id}>
                  <Button
                    className="h-auto min-w-0 flex-1 flex-col items-stretch gap-1 px-3 py-2 text-start font-normal"
                    onClick={() => {
                      openSaved(connectionId, query)
                      setOpen(false)
                    }}
                    variant="ghost"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-sm">{query.name}</span>
                      {query.connectionId === null && (
                        <Badge className="shrink-0 font-normal" size="sm" variant="outline">
                          All connections
                        </Badge>
                      )}
                    </span>
                    <span className="truncate font-mono text-muted-foreground text-xs">{firstLine(query.sql)}</span>
                    <span className="text-muted-foreground text-xs">Updated {timeAgo(query.updatedAt)}</span>
                  </Button>
                  <Menu>
                    <MenuTrigger
                      render={<Button aria-label={`Actions for ${query.name}`} size="icon-sm" variant="ghost" />}
                    >
                      <EllipsisIcon aria-hidden="true" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => setRenaming(query)}>
                        <PencilIcon aria-hidden="true" />
                        Rename
                      </MenuItem>
                      <MenuItem onClick={() => setDeleting(query)} variant="destructive">
                        <Trash2Icon aria-hidden="true" />
                        Delete
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              ))
            )}
          </div>
        </PopoverPopup>
      </Popover>

      <RenameSavedQueryDialog onOpenChange={(isOpen) => !isOpen && setRenaming(null)} query={renaming} />

      <ConfirmDialog
        confirmLabel="Delete"
        description={
          <>
            <span className="font-medium text-foreground">"{deleting?.name}"</span> is removed for everyone using this
            PowDB.
          </>
        }
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toastManager.add({ type: 'success', title: 'Deleted', timeout: 1500 })
              setDeleting(null)
            },
            onError: (err) => toastManager.add({ type: 'error', title: 'Could not delete', description: err.message }),
          })
        }}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        open={Boolean(deleting)}
        title="Delete saved query?"
      />
    </>
  )
}

function RenameSavedQueryDialog({
  query,
  onOpenChange,
}: {
  query: SavedQuery | null
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const update = useUpdateSavedQuery()

  // undefined (not null) so the first render also applies a query given on mount
  const [prevQuery, setPrevQuery] = useState<SavedQuery | null | undefined>(undefined)
  if (query !== prevQuery) {
    setPrevQuery(query)
    if (query) {
      setName(query.name)
      setError(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!query) return
    const trimmed = name.trim()
    if (!trimmed) return setError('Give the query a name.')
    if (trimmed === query.name) return onOpenChange(false)
    setError(null)
    update.mutate(
      { id: query.id, patch: { name: trimmed } },
      {
        onSuccess: () => {
          toastManager.add({ type: 'success', title: 'Renamed', timeout: 1500 })
          onOpenChange(false)
        },
        onError: (err) => setError(err.message),
      },
    )
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(query)}>
      <DialogPopup className="sm:max-w-md">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename query</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Field>
              <FieldLabel htmlFor="rename-saved-query">Name</FieldLabel>
              <Input
                autoFocus
                id="rename-saved-query"
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                value={name}
              />
              {error && <FieldDescription className="text-destructive-foreground">{error}</FieldDescription>}
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!name.trim()} loading={update.isPending} type="submit">
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
