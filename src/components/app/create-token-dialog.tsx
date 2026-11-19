import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { ConnectSection } from '@/components/app/ai-access-guides'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FormError } from '@/components/app/auth-card'
import { CopyButton } from '@/components/app/copy-button'
import { createTokenFn } from '@/api/tokens.functions'
import { connectionsQuery } from '@/lib/queries'
import { DEFAULT_EXPIRY, EXPIRY_OPTIONS, expiryDays } from '@/lib/token-expiry'
import type { TokenScope } from '@/lib/types'
import { SCOPES, SCOPE_HELP } from './ai-access-labels'

/**
 * Create a token. Step 1 is the form. After it is created, the same dialog switches to
 * step 2: the token is shown once and the connect guides are filled with it. The token is
 * React state only, and it is gone once the dialog has closed.
 */
export function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const { data: connections } = useQuery(connectionsQuery())
  const [name, setName] = useState('')
  const [scope, setScope] = useState<TokenScope>('read')
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY)
  const [allConnections, setAllConnections] = useState(true)
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      createTokenFn({
        data: {
          name: name.trim(),
          scope,
          connections: allConnections ? 'all' : picked,
          expiresInDays: expiryDays(expiry),
        },
      }),
    onSuccess: ({ token }) => {
      setCreated(token)
      void queryClient.invalidateQueries({ queryKey: ['tokens'] })
    },
    onError: (err) => setError(err.message),
  })

  const togglePick = (id: string, on: boolean) =>
    setPicked((ids) => (on ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id)))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Give the token a name, such as the tool or person who will use it.')
    if (!allConnections && picked.length === 0)
      return setError('Pick at least one connection, or choose All connections.')
    setError(null)
    create.mutate()
  }

  return (
    <Dialog
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setCreated(null)
      }}
      open={open}
    >
      <DialogPopup className={created ? 'sm:max-w-3xl' : 'sm:max-w-xl'}>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect your AI tool</DialogTitle>
              <DialogDescription>
                Copy the token, then follow the guide for your tool. Each guide already has the token filled in.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              <Alert variant="warning">
                <CircleAlertIcon />
                <AlertDescription>Copy this token now. It will not be shown again.</AlertDescription>
              </Alert>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs">
                  {created}
                </code>
                <CopyButton label="Copy token" text={created} />
              </div>
              <ConnectSection modes={['http']} token={created} />
            </DialogPanel>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form className="contents" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Create token</DialogTitle>
              <DialogDescription>
                A token lets an AI tool or script use PowView. Each token can be revoked at any time.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-5">
              <Field>
                <FieldLabel htmlFor="token-name">Name</FieldLabel>
                <Input
                  autoFocus
                  id="token-name"
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Claude Code on my laptop"
                  value={name}
                />
              </Field>
              <Field>
                <FieldLabel>Access</FieldLabel>
                <Select items={SCOPES} onValueChange={(v) => v && setScope(v as TokenScope)} value={scope}>
                  <SelectTrigger aria-label="Access">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {SCOPES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldDescription>{SCOPE_HELP[scope]}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Expires</FieldLabel>
                <Select items={EXPIRY_OPTIONS} onValueChange={(v) => v && setExpiry(v)} value={expiry}>
                  <SelectTrigger aria-label="Expires">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {EXPIRY_OPTIONS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldDescription>
                  {expiry === 'never'
                    ? 'Only for tokens you will revoke yourself.'
                    : 'After this time the token stops working. It stays in the list until you revoke it.'}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Connections</FieldLabel>
                <Label className="cursor-pointer font-normal">
                  <Checkbox checked={allConnections} onCheckedChange={(v) => setAllConnections(Boolean(v))} />
                  All connections
                </Label>
                {!allConnections && (
                  <div className="flex w-full flex-col gap-2 rounded-lg border p-3">
                    {(connections ?? []).map((conn) => (
                      <Label className="cursor-pointer font-normal" key={conn.id}>
                        <Checkbox
                          checked={picked.includes(conn.id)}
                          onCheckedChange={(v) => togglePick(conn.id, Boolean(v))}
                        />
                        <span className="min-w-0 truncate">{conn.name}</span>
                        <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                          {conn.host}/{conn.database}
                        </span>
                      </Label>
                    ))}
                    {connections?.length === 0 && (
                      <p className="text-muted-foreground text-sm">Add a connection first.</p>
                    )}
                  </div>
                )}
                <FieldDescription>
                  {allConnections
                    ? 'The token can use every connection that allows AI access.'
                    : 'The token can only use the connections you pick.'}
                </FieldDescription>
              </Field>
              <FormError message={error} />
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
              <Button loading={create.isPending} type="submit">
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  )
}
