import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, Trash2Icon, ContainerIcon } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { Box, EmptyLine } from '@/components/app/ai-access-activity'
import { SCOPE_BADGE } from '@/components/app/ai-access-labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toastManager } from '@/components/ui/toast'
import { revokeTokenFn } from '@/api/tokens.functions'
import { timeAgo } from '@/lib/format'
import { connectionsQuery, tokensQuery } from '@/lib/queries'
import { expiryStatus } from '@/lib/token-expiry'
import type { ApiTokenInfo } from '@/lib/types'

export function TokensSection({
  onCreate,
  onConnectWithoutToken,
}: {
  onCreate: () => void
  onConnectWithoutToken: () => void
}) {
  const [toRevoke, setToRevoke] = useState<ApiTokenInfo | null>(null)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <Button className="text-muted-foreground" onClick={onConnectWithoutToken} size="sm" variant="ghost">
          <ContainerIcon aria-hidden="true" />
          Connect without a token (Docker)
        </Button>
        <Button onClick={onCreate} size="sm" variant="outline">
          <PlusIcon aria-hidden="true" />
          Create token
        </Button>
      </div>
      <TokensTable onRevoke={setToRevoke} />

      <RevokeDialog onClose={() => setToRevoke(null)} token={toRevoke} />
    </section>
  )
}

function TokensTable({ onRevoke }: { onRevoke: (token: ApiTokenInfo) => void }) {
  const { data: tokens, isPending, error } = useQuery(tokensQuery())
  const { data: connections } = useQuery(connectionsQuery())
  const names = new Map((connections ?? []).map((c) => [c.id, c.name]))

  if (error)
    return (
      <Box>
        <EmptyLine>{error.message}</EmptyLine>
      </Box>
    )
  if (isPending)
    return (
      <Box>
        <EmptyLine>Loading tokens…</EmptyLine>
      </Box>
    )
  if (tokens.length === 0) {
    return (
      <Box>
        <EmptyLine>No tokens yet. Create one to connect an AI tool.</EmptyLine>
      </Box>
    )
  }

  return (
    <Box>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Connections</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((t) => {
            const badge = SCOPE_BADGE[t.scope]
            const conns =
              t.connections === 'all'
                ? 'All connections'
                : t.connections.map((id) => names.get(id) ?? 'Removed connection').join(', ')
            const expiry = expiryStatus(t.expiresAt)
            return (
              <TableRow key={t.id}>
                {/* takes the remaining width and truncates, so the table never scrolls sideways */}
                <TableCell className="w-full max-w-0" title={`Created ${timeAgo(t.createdAt)}`}>
                  <div className="truncate font-medium">{t.name}</div>
                  <div className="truncate text-muted-foreground text-xs">
                    <span className="font-mono">{t.prefix}…</span> ·{' '}
                    {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </TableCell>
                <TableCell className="max-w-[12rem] truncate" title={conns}>
                  {conns}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {expiry.expired ? (
                    <Badge variant="error">Expired</Badge>
                  ) : (
                    <span className="text-muted-foreground">{expiry.text}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button aria-label={`Revoke ${t.name}`} onClick={() => onRevoke(t)} size="sm" variant="ghost">
                    <Trash2Icon aria-hidden="true" />
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Box>
  )
}

function RevokeDialog({ token, onClose }: { token: ApiTokenInfo | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const revoke = useMutation({
    mutationFn: (id: string) => revokeTokenFn({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tokens'] })
      toastManager.add({ type: 'success', title: 'Token revoked' })
      onClose()
    },
    onError: (err) => toastManager.add({ type: 'error', title: 'Could not revoke token', description: err.message }),
  })
  return (
    <ConfirmDialog
      confirmLabel="Revoke token"
      description={
        <>
          <span className="font-medium text-foreground">{token?.name}</span> will stop working right away. Any AI tool
          that uses it will lose access.
        </>
      }
      destructive
      loading={revoke.isPending}
      onConfirm={() => token && revoke.mutate(token.id)}
      onOpenChange={(open) => !open && onClose()}
      open={Boolean(token)}
      title="Revoke token?"
    />
  )
}
