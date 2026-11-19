import { useState } from 'react'
import { ActivitySection } from '@/components/app/ai-access-activity'
import { ConnectSection } from '@/components/app/ai-access-guides'
import { TokensSection } from '@/components/app/ai-access-tokens'
import { CreateTokenDialog } from '@/components/app/create-token-dialog'
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
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { useAiAccessDialog } from '@/lib/ai-access-dialog'

type AiTab = 'tokens' | 'activity'

/** Same height on every tab, so switching never moves the dialog. This is the only scroll area inside it. */
const PANEL = 'h-[min(36rem,calc(100dvh-14rem))] flex-none overflow-y-auto'

export function AiAccessDialog() {
  const open = useAiAccessDialog((s) => s.open)
  const setOpen = useAiAccessDialog((s) => s.setOpen)
  const [tab, setTab] = useState<AiTab>('tokens')
  const [createOpen, setCreateOpen] = useState(false)
  const [createKey, setCreateKey] = useState(0)
  const [dockerOpen, setDockerOpen] = useState(false)

  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTab('tokens')
  }

  const openCreate = () => {
    setCreateKey((k) => k + 1)
    setCreateOpen(true)
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        // the nested dialogs go with their parent: they must not reappear on the next open
        if (!next) {
          setCreateOpen(false)
          setDockerOpen(false)
        }
      }}
      open={open}
    >
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI access</DialogTitle>
          <DialogDescription>
            Let AI tools like Claude Code or Cursor query your databases through PowDB. They never see database
            passwords. Each connection decides what AI may do; new connections are read-only for AI.
          </DialogDescription>
        </DialogHeader>

        <Tabs className="min-h-0 gap-4" onValueChange={(v) => setTab(v as AiTab)} value={tab}>
          <div className="px-6">
            <TabsList>
              <TabsTab value="tokens">Tokens</TabsTab>
              <TabsTab value="activity">Activity</TabsTab>
            </TabsList>
          </div>

          <TabsPanel className={PANEL} value="tokens">
            <div className="px-6 pb-6">
              <TokensSection onConnectWithoutToken={() => setDockerOpen(true)} onCreate={openCreate} />
            </div>
          </TabsPanel>

          <TabsPanel className={PANEL} value="activity">
            <div className="px-6 pb-6">
              <ActivitySection />
            </div>
          </TabsPanel>
        </Tabs>

        {/* Direct children of the popup, so they are nested dialogs and focus is handled correctly. */}
        <CreateTokenDialog key={createKey} onOpenChange={setCreateOpen} open={createOpen} />
        <ConnectWithoutTokenDialog onOpenChange={setDockerOpen} open={dockerOpen} />
      </DialogPopup>
    </Dialog>
  )
}

/** The connect guide for Docker. It needs no token, so only the Docker method is offered. */
function ConnectWithoutTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect without a token</DialogTitle>
          <DialogDescription>
            Your AI tool runs PowDB's command inside the Docker container, so no token is needed. Docker must run on the
            same machine.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ConnectSection modes={['docker']} token={null} />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
