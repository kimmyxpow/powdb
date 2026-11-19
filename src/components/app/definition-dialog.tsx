import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CopyIcon, SquareTerminalIcon } from 'lucide-react'
import { SqlCodeView } from '@/components/sql/codemirror'
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
import { Skeleton } from '@/components/ui/skeleton'
import { toastManager } from '@/components/ui/toast'
import { copyText } from '@/lib/export'
import { definitionQuery } from '@/lib/queries'
import { useRetained } from '@/hooks/use-retained'
import { useAppStore } from '@/lib/store'

export interface DefinitionTarget {
  kind: 'function' | 'type'
  oid: number
  title: string
  subtitle?: string
}

export function DefinitionDialog({
  connectionId,
  database,
  target,
  onClose,
}: {
  connectionId: string
  database: string
  target: DefinitionTarget | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const openSqlTab = useAppStore((s) => s.openSqlTab)
  // keep the last definition on screen while the dialog animates out
  const shown = useRetained(target)
  const { data, isPending, error } = useQuery({
    ...definitionQuery(connectionId, database, shown?.kind ?? 'function', shown?.oid ?? 0),
    enabled: Boolean(shown),
  })

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={Boolean(target)}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{shown?.title}</DialogTitle>
          {shown?.subtitle && <DialogDescription>{shown.subtitle}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>
          <div className="overflow-hidden rounded-lg border bg-muted/30">
            {isPending ? (
              <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : error ? (
              <p className="p-4 text-destructive-foreground text-sm">{error.message}</p>
            ) : (
              <SqlCodeView maxHeight="60vh" value={data ?? ''} />
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={!data}
            onClick={() => {
              void copyText(data ?? '')
              toastManager.add({ type: 'success', title: 'Definition copied' })
            }}
            variant="ghost"
          >
            <CopyIcon aria-hidden="true" />
            Copy
          </Button>
          <Button
            disabled={!data}
            onClick={() => {
              openSqlTab(connectionId, data ?? '', shown?.title)
              onClose()
              void navigate({ to: '/c/$connId/$db/sql', params: { connId: connectionId, db: database } })
            }}
          >
            <SquareTerminalIcon aria-hidden="true" />
            Open in SQL editor
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
