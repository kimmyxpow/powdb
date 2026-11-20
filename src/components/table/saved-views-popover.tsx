import { useQuery } from '@tanstack/react-query'
import {
  BookmarkIcon,
  CheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCcwIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import {
  savedViewsQuery,
  sameViewState,
  isEmptyViewState,
  useCreateSavedView,
  useDeleteSavedView,
  useUpdateSavedView,
} from '@/lib/saved-views'
import type { SavedViewTarget } from '@/lib/saved-views'
import type { SavedView, SavedViewState } from '@/lib/types'

const NAME_MAX = 80

/** Toolbar button that lists the saved views of one table. Opening a view applies its state to the table. */
export function SavedViewsPopover({
  target,
  current,
  onApply,
}: {
  target: SavedViewTarget
  /** the table's view state now (filters, sort, search, hidden columns) */
  current: SavedViewState
  onApply: (state: SavedViewState) => void
}) {
  const { data, error } = useQuery(savedViewsQuery(target.connectionId, target.database, target.schema, target.table))
  const views = data ?? []
  const empty = isEmptyViewState(current)
  // the view the table is showing now, if any (the button shows its name)
  const active = empty ? undefined : views.find((v) => sameViewState(v.state, current))

  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newError, setNewError] = useState<string | null>(null)
  const create = useCreateSavedView()
  const update = useUpdateSavedView()
  const remove = useDeleteSavedView()

  // Forms are reset once the popover has finished closing, so the rows do not change while it fades out.
  const reset = () => {
    setRenamingId(null)
    setRenameDraft('')
    setRenameError(null)
    setAdding(false)
    setNewName('')
    setNewError(null)
  }

  const startRename = (view: SavedView) => {
    setRenamingId(view.id)
    setRenameDraft(view.name)
    setRenameError(null)
  }

  const submitRename = (e: FormEvent, view: SavedView) => {
    e.preventDefault()
    const name = renameDraft.trim()
    if (!name) return setRenameError('Enter a name.')
    if (name === view.name) return setRenamingId(null)
    setRenameError(null)
    update.mutate(
      { id: view.id, patch: { name } },
      {
        onSuccess: () => {
          setRenamingId(null)
          toastManager.add({ type: 'success', title: 'View updated', timeout: 1500 })
        },
        onError: (err) => setRenameError(err.message),
      },
    )
  }

  const overwrite = (view: SavedView) => {
    update.mutate(
      { id: view.id, patch: { state: current } },
      {
        onSuccess: () => toastManager.add({ type: 'success', title: 'View updated', timeout: 1500 }),
        onError: (err) => toastManager.add({ type: 'error', title: 'Could not update', description: err.message }),
      },
    )
  }

  const removeView = (view: SavedView) => {
    remove.mutate(view.id, {
      onSuccess: () => toastManager.add({ type: 'success', title: 'View deleted', timeout: 1500 }),
      onError: (err) => toastManager.add({ type: 'error', title: 'Could not delete', description: err.message }),
    })
  }

  const submitNew = (e: FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return setNewError('Enter a name.')
    if (empty) return
    setNewError(null)
    create.mutate(
      { ...target, name, state: current },
      {
        onSuccess: () => {
          setAdding(false)
          setNewName('')
          toastManager.add({ type: 'success', title: 'View saved', timeout: 1500 })
        },
        onError: (err) => setNewError(err.message),
      },
    )
  }

  // Escape cancels the inline form and keeps the popover open.
  const cancelOnEscape = (e: KeyboardEvent, cancel: () => void) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    cancel()
  }

  return (
    <Popover
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) reset()
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label={active ? `Saved views: ${active.name}` : 'Saved views'}
            className="min-w-0 max-w-52"
            size="sm"
            variant="outline"
          />
        }
      >
        <BookmarkIcon aria-hidden="true" />
        <span className="min-w-0 truncate max-sm:hidden">{active ? active.name : 'Views'}</span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] *:data-[slot=popover-viewport]:py-0 *:data-[slot=popover-viewport]:[--viewport-inline-padding:0px]"
      >
        <div className="border-b px-3 py-2">
          <span className="font-medium text-sm">Saved views</span>
        </div>

        <div className="scrollbar-thin max-h-72 overflow-y-auto p-1.5">
          {error && <p className="px-3 py-4 text-destructive-foreground text-sm">{error.message}</p>}
          {data && views.length === 0 && (
            <p className="px-3 py-6 text-center text-muted-foreground text-sm">
              Save the filters, sort, search and hidden columns of this table to open them again in one click.
            </p>
          )}
          {views.map((view) =>
            renamingId === view.id ? (
              <form className="flex flex-col gap-1 px-1 py-0.5" key={view.id} onSubmit={(e) => submitRename(e, view)}>
                <Input
                  aria-invalid={renameError ? true : undefined}
                  aria-label="View name"
                  autoFocus
                  maxLength={NAME_MAX}
                  onChange={(e) => {
                    setRenameDraft(e.target.value)
                    setRenameError(null)
                  }}
                  onKeyDown={(e) => cancelOnEscape(e, () => setRenamingId(null))}
                  size="sm"
                  value={renameDraft}
                />
                {renameError && <p className="text-destructive-foreground text-xs">{renameError}</p>}
              </form>
            ) : (
              <div className="flex items-center gap-1" key={view.id}>
                <Button
                  aria-current={active?.id === view.id ? 'true' : undefined}
                  className="min-w-0 flex-1 justify-start font-normal"
                  onClick={() => {
                    onApply(view.state)
                    setOpen(false)
                  }}
                  variant="ghost"
                >
                  <span className="min-w-0 flex-1 truncate text-start">{view.name}</span>
                  {active?.id === view.id && <CheckIcon aria-hidden="true" />}
                </Button>
                <Menu>
                  <MenuTrigger
                    render={<Button aria-label={`Actions for ${view.name}`} size="icon-xs" variant="ghost" />}
                  >
                    <MoreHorizontalIcon aria-hidden="true" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => startRename(view)}>
                      <PencilIcon aria-hidden="true" />
                      Rename
                    </MenuItem>
                    <MenuItem disabled={empty || sameViewState(view.state, current)} onClick={() => overwrite(view)}>
                      <RefreshCcwIcon aria-hidden="true" />
                      Replace with current view
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem onClick={() => removeView(view)} variant="destructive">
                      <Trash2Icon aria-hidden="true" />
                      Delete
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            ),
          )}
        </div>

        <div className="border-t p-2">
          {adding ? (
            <form className="flex flex-col gap-1.5" onSubmit={submitNew}>
              <div className="flex items-center gap-1.5">
                <Input
                  aria-invalid={newError ? true : undefined}
                  aria-label="View name"
                  autoFocus
                  maxLength={NAME_MAX}
                  onChange={(e) => {
                    setNewName(e.target.value)
                    setNewError(null)
                  }}
                  onKeyDown={(e) => cancelOnEscape(e, () => setAdding(false))}
                  placeholder="View name"
                  size="sm"
                  value={newName}
                />
                <Button loading={create.isPending} size="sm" type="submit">
                  Save
                </Button>
                <Button aria-label="Cancel" onClick={() => setAdding(false)} size="icon-sm" variant="ghost">
                  <XIcon />
                </Button>
              </div>
              {newError && <p className="text-destructive-foreground text-xs">{newError}</p>}
            </form>
          ) : empty ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex" />}>
                <Button className="w-full" disabled size="sm" variant="outline">
                  Save current view
                </Button>
              </TooltipTrigger>
              <TooltipPopup>Add a filter, sort, search or hidden column first</TooltipPopup>
            </Tooltip>
          ) : (
            <Button className="w-full" onClick={() => setAdding(true)} size="sm" variant="outline">
              Save current view
            </Button>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
