import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ArrowRightIcon,
  BotIcon,
  CopyPlusIcon,
  DatabaseIcon,
  EllipsisIcon,
  FileTextIcon,
  LinkIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactElement } from 'react'
import { deleteConnectionFn } from '@/api/connections.functions'
import { ConnectionAvatar, Logo } from '@/components/app/brand'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { ConnectionDialog } from '@/components/app/connection-dialog'
import { SettingsDialog } from '@/components/app/settings-dialog'
import { UpdateNotice } from '@/components/app/update-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Skeleton } from '@/components/ui/skeleton'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { buildConnectionUrl, looksLikeUrl } from '@/lib/connection-url'
import { copyText } from '@/lib/export'
import { timeAgo } from '@/lib/format'
import { useAiAccessDialog } from '@/lib/ai-access-dialog'
import { connectionsQuery, keys } from '@/lib/queries'
import type { ConnectionInfo } from '@/lib/types'

export const Route = createFileRoute('/')({
  component: Home,
  head: () => ({ meta: [{ title: 'Connections · PowView' }] }),
})

function Home() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: connections, isPending, error } = useQuery(connectionsQuery())
  const [dialog, setDialog] = useState<{ open: boolean; connection: ConnectionInfo | null; url?: string }>({
    open: false,
    connection: null,
  })
  const [toDelete, setToDelete] = useState<ConnectionInfo | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const setAiAccessOpen = useAiAccessDialog((s) => s.setOpen)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteConnectionFn({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.connections() })
      toastManager.add({ type: 'success', title: 'Connection deleted' })
      setToDelete(null)
    },
    onError: (err) => toastManager.add({ type: 'error', title: 'Delete failed', description: err.message }),
  })

  const connect = (conn: ConnectionInfo) => navigate({ to: '/c/$connId', params: { connId: conn.id } })

  const openNew = (url?: string) => setDialog({ open: true, connection: null, url })

  const hasConnections = Boolean(connections?.length)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <div className="flex items-center gap-1">
            <UpdateNotice />
            <Button onClick={() => setAiAccessOpen(true)} size="sm" variant="ghost">
              <BotIcon aria-hidden="true" />
              AI access
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button aria-label="Settings" onClick={() => setSettingsOpen(true)} size="icon-sm" variant="ghost" />
                }
              >
                <SettingsIcon />
              </TooltipTrigger>
              <TooltipPopup>Settings</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
        {error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Could not load connections</EmptyTitle>
              <EmptyDescription>{error.message}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : !isPending && !hasConnections ? (
          <Empty className="rounded-2xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DatabaseIcon />
              </EmptyMedia>
              <EmptyTitle>Connect your first database</EmptyTitle>
              <EmptyDescription>Paste a PostgreSQL connection URL, or fill in the details by hand.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="max-w-md">
              <QuickConnect onSubmit={openNew} />
              <Button onClick={() => openNew()} variant="outline">
                <PlusIcon aria-hidden="true" />
                Enter details manually
              </Button>
              <p className="text-muted-foreground text-xs">
                Want sample data? Run <code className="rounded bg-muted px-1 py-0.5">bun run demo:db</code> and connect
                to <code className="rounded bg-muted px-1 py-0.5">postgresql://demo:demo@localhost:55432/shop</code>
              </p>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="font-heading font-semibold text-2xl tracking-tight">Connections</h1>
                <p className="mt-1 text-muted-foreground text-sm">Pick a database to explore, or add a new one.</p>
              </div>
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <QuickConnect className="sm:w-80" onSubmit={openNew} />
                <Button onClick={() => openNew()}>
                  <PlusIcon aria-hidden="true" />
                  New
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {/* same header + grid while loading, only the cards are placeholders */}
              {isPending && [0, 1].map((i) => <Skeleton className="h-32 rounded-2xl" key={i} />)}
              {(connections ?? []).map((conn) => (
                <ConnectionCard
                  connection={conn}
                  key={conn.id}
                  onConnect={() => connect(conn)}
                  onDelete={() => setToDelete(conn)}
                  onDuplicate={() =>
                    setDialog({
                      open: true,
                      connection: null,
                      url: buildConnectionUrl(conn),
                    })
                  }
                  onEdit={() => setDialog({ open: true, connection: conn })}
                />
              ))}
              {/* only once the cards are known: placed after the placeholders it would jump
                  to another cell when the real number of cards differs */}
              {!isPending && (
                <Button
                  className="h-auto min-h-32 flex-col rounded-2xl border-dashed font-normal text-muted-foreground shadow-none hover:text-foreground"
                  onClick={() => openNew()}
                  variant="outline"
                >
                  <PlusIcon aria-hidden="true" className="size-5" />
                  Add connection
                </Button>
              )}
            </div>
          </>
        )}
      </main>

      <ConnectionDialog
        connection={dialog.connection}
        initialUrl={dialog.url}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSaved={(conn, shouldConnect) => {
          if (shouldConnect) void connect(conn)
        }}
        open={dialog.open}
      />
      <SettingsDialog onOpenChange={setSettingsOpen} open={settingsOpen} />
      <ConfirmDialog
        confirmLabel="Delete connection"
        description={
          <>
            <span className="font-medium text-foreground">{toDelete?.name}</span> will be removed from PowView. The
            database itself is not touched.
          </>
        }
        destructive
        loading={deleteMutation.isPending}
        onConfirm={() => toDelete && deleteMutation.mutate(toDelete.id)}
        onOpenChange={(open) => !open && setToDelete(null)}
        open={Boolean(toDelete)}
        title="Delete connection?"
      />
    </div>
  )
}

function QuickConnect({ onSubmit, className }: { onSubmit: (url: string) => void; className?: string }) {
  const [value, setValue] = useState('')
  const valid = looksLikeUrl(value)
  return (
    <form
      className={className ?? 'w-full'}
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) {
          onSubmit(value.trim())
          setValue('')
        }
      }}
    >
      <InputGroup>
        <InputGroupInput
          aria-label="Connection URL"
          onChange={(e) => setValue(e.target.value)}
          placeholder="postgresql://user:pass@host:5432/db"
          spellCheck={false}
          value={value}
        />
        <InputGroupAddon align="inline-end">
          {valid ? (
            <Button size="icon-xs" type="submit" variant="ghost" aria-label="Continue">
              <ArrowRightIcon />
            </Button>
          ) : (
            <Kbd>↵</Kbd>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

function ConnectionCard({
  connection: conn,
  onConnect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  connection: ConnectionInfo
  onConnect: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const managed = Boolean(conn.managed)
  return (
    <Card className="group gap-4 p-4 transition-[border-color,box-shadow] hover:border-ring/50 hover:shadow-sm">
      <button
        aria-label={`Open ${conn.name}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onConnect}
        type="button"
      />
      <div className="pointer-events-none relative flex items-start gap-3">
        <ConnectionAvatar className="size-10 text-sm" color={conn.color} name={conn.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{conn.name}</div>
          <div className="truncate font-mono text-muted-foreground text-xs">
            {conn.user}@{conn.host}:{conn.port}/{conn.database}
          </div>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label="Connection actions"
                className="pointer-events-auto -me-1.5 -mt-1"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <ManagedTip managed={managed}>
              <MenuItem disabled={managed} onClick={onEdit}>
                <PencilIcon aria-hidden="true" />
                Edit
              </MenuItem>
            </ManagedTip>
            <MenuItem onClick={onDuplicate}>
              <CopyPlusIcon aria-hidden="true" />
              Duplicate
            </MenuItem>
            <MenuItem
              onClick={() => {
                void copyText(buildConnectionUrl(conn))
                toastManager.add({
                  type: 'success',
                  title: 'Connection URL copied',
                  description: 'Password not included.',
                })
              }}
            >
              <LinkIcon aria-hidden="true" />
              Copy URL
            </MenuItem>
            <MenuSeparator />
            <ManagedTip managed={managed}>
              <MenuItem disabled={managed} onClick={onDelete} variant="destructive">
                <Trash2Icon aria-hidden="true" />
                Delete
              </MenuItem>
            </ManagedTip>
          </MenuPopup>
        </Menu>
      </div>
      <div className="pointer-events-none relative flex items-center gap-1.5">
        {managed && (
          <Badge variant="outline">
            <FileTextIcon aria-hidden="true" />
            Managed
          </Badge>
        )}
        {conn.production && (
          <Badge variant="destructive">
            <ShieldAlertIcon aria-hidden="true" />
            Production
          </Badge>
        )}
        {conn.readOnly && (
          <Badge variant="warning">
            <LockIcon aria-hidden="true" />
            Read-only
          </Badge>
        )}
        {conn.ssl !== 'disable' && (
          <Badge variant="success">
            <ShieldCheckIcon aria-hidden="true" />
            SSL
          </Badge>
        )}
        <span className="ms-auto text-muted-foreground text-xs">
          {conn.lastUsedAt ? `Opened ${timeAgo(conn.lastUsedAt)}` : 'Never opened'}
        </span>
      </div>
    </Card>
  )
}

/** Explains why a menu item is off for a connection that comes from powview.yaml. */
function ManagedTip({ managed, children }: { managed: boolean; children: ReactElement }) {
  if (!managed) return children
  return (
    // A disabled menu item ignores the pointer, so the tooltip is triggered by a wrapper.
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>{children}</TooltipTrigger>
      <TooltipPopup side="left">Managed by powview.yaml. Change the file and restart PowView.</TooltipPopup>
    </Tooltip>
  )
}
