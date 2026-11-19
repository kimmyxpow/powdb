import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BotIcon,
  CircleCheckIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  LockIcon,
  NetworkIcon,
  PlugZapIcon,
  ShieldAlertIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { createConnectionFn, testConnectionFn, updateConnectionFn } from '@/api/connections.functions'
import { AI_ACCESS_ITEMS } from './ai-access-labels'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { RadioGroupPrimitive, RadioPrimitive } from '@/components/ui/radio-group'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'
import { parseConnectionUrl } from '@/lib/connection-url'
import { SSH_KEY_MESSAGE, looksLikePrivateKey, shortenMiddle } from '@/lib/ssh'
import { keys } from '@/lib/queries'
import { CONNECTION_COLORS } from '@/lib/types'
import type {
  AiAccess,
  ConnectionColor,
  ConnectionInfo,
  ConnectionInput,
  SshAuth,
  SshInput,
  SslMode,
  TestConnectionResult,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { colorClasses } from './brand'

const SSL_ITEMS: { label: string; value: SslMode }[] = [
  { label: 'Disabled', value: 'disable' },
  { label: 'Required', value: 'require' },
  { label: 'Verify certificate', value: 'verify-full' },
]

const AUTH_ITEMS: { label: string; value: SshAuth }[] = [
  { label: 'Password', value: 'password' },
  { label: 'Private key', value: 'key' },
]

interface FormState {
  url: string
  name: string
  color: ConnectionColor
  host: string
  port: string
  database: string
  user: string
  password: string
  ssl: SslMode
  readOnly: boolean
  production: boolean
  aiAccess: AiAccess
  ssh: boolean
  sshHost: string
  sshPort: string
  sshUser: string
  sshAuth: SshAuth
  sshPassword: string
  sshKey: string
  sshPassphrase: string
  /** the user chose Replace or Remove for a saved key: show the key field */
  sshKeyReset: boolean
  sshClearKey: boolean
}

const SSH_EMPTY: Pick<
  FormState,
  | 'ssh'
  | 'sshHost'
  | 'sshPort'
  | 'sshUser'
  | 'sshAuth'
  | 'sshPassword'
  | 'sshKey'
  | 'sshPassphrase'
  | 'sshKeyReset'
  | 'sshClearKey'
> = {
  ssh: false,
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  sshAuth: 'password',
  sshPassword: '',
  sshKey: '',
  sshPassphrase: '',
  sshKeyReset: false,
  sshClearKey: false,
}

function initialState(conn?: ConnectionInfo | null, url?: string): FormState {
  const base: FormState = conn
    ? {
        url: '',
        name: conn.name,
        color: conn.color,
        host: conn.host,
        port: String(conn.port),
        database: conn.database,
        user: conn.user,
        password: '',
        ssl: conn.ssl,
        readOnly: conn.readOnly,
        production: conn.production === true,
        aiAccess: conn.aiAccess,
        ...SSH_EMPTY,
        ssh: Boolean(conn.ssh),
        sshHost: conn.ssh?.host ?? '',
        sshPort: String(conn.ssh?.port ?? 22),
        sshUser: conn.ssh?.user ?? '',
        sshAuth: conn.ssh?.auth ?? 'password',
      }
    : {
        url: '',
        name: '',
        color: CONNECTION_COLORS[Math.floor(Math.random() * CONNECTION_COLORS.length)]!,
        host: 'localhost',
        port: '5432',
        database: 'postgres',
        user: 'postgres',
        password: '',
        ssl: 'disable',
        readOnly: false,
        production: false,
        aiAccess: 'read',
        ...SSH_EMPTY,
      }
  if (url) {
    const parsed = parseConnectionUrl(url)
    if (parsed) return { ...base, ...parsed, url, port: String(parsed.port) }
  }
  return base
}

/** The SSH object sent to the server. Empty secrets are left out, so the stored ones are kept. */
function sshInputOf(s: FormState): SshInput {
  const key = s.sshAuth === 'key'
  return {
    host: s.sshHost.trim(),
    port: Number(s.sshPort) || 22,
    user: s.sshUser.trim(),
    auth: s.sshAuth,
    password: !key && s.sshPassword ? s.sshPassword : undefined,
    privateKey: key && s.sshKey.trim() ? s.sshKey : undefined,
    passphrase: key && s.sshPassphrase ? s.sshPassphrase : undefined,
    clearKey: key && s.sshClearKey ? true : undefined,
  }
}

/** hadSsh: the saved connection has a tunnel. Turning SSH off then removes it (null). */
function toInput(s: FormState, hadSsh: boolean): ConnectionInput {
  return {
    name: s.name.trim() || `${s.database} @ ${s.host}`,
    color: s.color,
    host: s.host.trim(),
    port: Number(s.port) || 5432,
    database: s.database.trim(),
    user: s.user.trim(),
    password: s.password || undefined,
    ssl: s.ssl,
    readOnly: s.readOnly,
    production: s.production,
    aiAccess: s.aiAccess,
    ssh: s.ssh ? sshInputOf(s) : hadSsh ? null : undefined,
  }
}

export function ConnectionDialog({
  open,
  onOpenChange,
  connection,
  initialUrl,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection?: ConnectionInfo | null
  initialUrl?: string
  onSaved?: (conn: ConnectionInfo, connect: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<FormState>(() => initialState(connection, initialUrl))
  const [showPassword, setShowPassword] = useState(false)
  const [test, setTest] = useState<TestConnectionResult | null>(null)
  const keyFileInput = useRef<HTMLInputElement>(null)
  const isEdit = Boolean(connection)
  // Managed connections come from powview.yaml: they can be looked at here, not changed.
  const managed = Boolean(connection?.managed)
  const hadSsh = Boolean(connection?.ssh)

  const savedSsh = connection?.ssh
  const savedPassword = savedSsh?.auth === 'password' && savedSsh.hasPassword
  const savedKey = savedSsh?.auth === 'key' && savedSsh.hasKey
  const savedKeyShown = state.ssh && state.sshAuth === 'key' && savedKey && !state.sshKeyReset
  const keyInvalid =
    state.ssh &&
    state.sshAuth === 'key' &&
    !savedKeyShown &&
    state.sshKey.trim() !== '' &&
    !looksLikePrivateKey(state.sshKey)
  const sshSecretMissing = state.ssh
    ? state.sshAuth === 'password'
      ? !state.sshPassword && !savedPassword
      : !savedKeyShown && !state.sshKey.trim()
    : false
  const sshValid =
    !state.ssh || (state.sshHost.trim() !== '' && state.sshUser.trim() !== '' && !keyInvalid && !sshSecretMissing)

  // a fresh form when the dialog opens, or when another connection or URL is given
  const resetKey = open ? `${connection?.id}|${initialUrl}` : null
  const [shownFor, setShownFor] = useState<string | null>(null)
  if (resetKey !== shownFor) {
    setShownFor(resetKey)
    if (open) {
      setState(initialState(connection, initialUrl))
      setTest(null)
      setShowPassword(false)
    }
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((s) => ({ ...s, [key]: value }))
    setTest(null)
  }

  const onUrlChange = (value: string) => {
    const parsed = parseConnectionUrl(value)
    setState((s) => (parsed ? { ...s, ...parsed, url: value, port: String(parsed.port) } : { ...s, url: value }))
    setTest(null)
  }

  const testMutation = useMutation({
    mutationFn: () => testConnectionFn({ data: { id: connection?.id, input: toInput(state, hadSsh) } }),
    onSuccess: setTest,
    onError: (err) => setTest({ ok: false, error: err.message }),
  })

  const saveMutation = useMutation({
    mutationFn: async (connect: boolean) => {
      const input = toInput(state, hadSsh)
      const saved = connection
        ? await updateConnectionFn({ data: { id: connection.id, input } })
        : await createConnectionFn({ data: input })
      return { saved, connect }
    },
    onSuccess: ({ saved, connect }) => {
      void queryClient.invalidateQueries({ queryKey: keys.connections() })
      if (connection) {
        void queryClient.invalidateQueries({ queryKey: ['c', connection.id] })
      }
      toastManager.add({
        type: 'success',
        title: isEdit ? 'Connection updated' : 'Connection saved',
        description: saved.name,
      })
      onOpenChange(false)
      onSaved?.(saved, connect)
    },
    onError: (err) => toastManager.add({ type: 'error', title: 'Could not save connection', description: err.message }),
  })

  const canSubmit = state.host.trim() && state.database.trim() && state.user.trim() && sshValid

  const onKeyFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setState((s) => ({ ...s, sshKey: '', sshKeyReset: true, sshClearKey: false }))
    set('sshKey', await file.text())
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit connection' : 'New connection'}</DialogTitle>
          <DialogDescription>
            Connect to a PostgreSQL server. Paste a connection URL to fill everything in at once.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit && !managed) saveMutation.mutate(!isEdit)
          }}
        >
          <DialogPanel className="flex flex-col gap-5">
            {managed && (
              <Alert variant="info">
                <LockIcon />
                <AlertTitle>Managed by powview.yaml</AlertTitle>
                <AlertDescription>
                  Change the file and restart pow/view. The fields here are read-only.
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  disabled={managed}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder={`${state.database || 'database'} @ ${state.host || 'host'}`}
                  value={state.name}
                />
              </Field>
              <RadioGroupPrimitive
                aria-label="Color"
                className="flex h-9 items-center gap-1.5 sm:h-8"
                disabled={managed}
                onValueChange={(v) => set('color', v as ConnectionColor)}
                value={state.color}
              >
                {CONNECTION_COLORS.map((c) => (
                  <RadioPrimitive.Root
                    aria-label={c}
                    className={cn(
                      'size-5 cursor-pointer rounded-full outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 data-checked:ring-2',
                      colorClasses[c].dot,
                      colorClasses[c].ring,
                    )}
                    key={c}
                    value={c}
                  />
                ))}
              </RadioGroupPrimitive>
            </div>

            <section className="flex flex-col gap-4">
              <SectionTitle>Connection</SectionTitle>
              <Field>
                <FieldLabel>Connection URL</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    autoFocus={!isEdit}
                    disabled={managed}
                    onChange={(e) => onUrlChange(e.target.value)}
                    placeholder="postgresql://user:password@localhost:5432/database"
                    spellCheck={false}
                    value={state.url}
                  />
                  <InputGroupAddon>
                    <LinkIcon aria-hidden="true" />
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>Optional. Pasting a URL fills in the fields below.</FieldDescription>
              </Field>

              <div className="grid grid-cols-[1fr_7rem] gap-3">
                <Field>
                  <FieldLabel>Host</FieldLabel>
                  <Input
                    disabled={managed}
                    onChange={(e) => set('host', e.target.value)}
                    placeholder="localhost"
                    required
                    spellCheck={false}
                    value={state.host}
                  />
                </Field>
                <Field>
                  <FieldLabel>Port</FieldLabel>
                  <Input
                    disabled={managed}
                    inputMode="numeric"
                    onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))}
                    placeholder="5432"
                    value={state.port}
                  />
                </Field>
              </div>
              {state.ssh && (
                <p className="-mt-2 text-muted-foreground text-xs">
                  Host and port as seen from the SSH server, often localhost and 5432.
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Database</FieldLabel>
                  <Input
                    disabled={managed}
                    onChange={(e) => set('database', e.target.value)}
                    placeholder="postgres"
                    required
                    spellCheck={false}
                    value={state.database}
                  />
                </Field>
                <Field>
                  <FieldLabel>User</FieldLabel>
                  <Input
                    autoComplete="off"
                    disabled={managed}
                    onChange={(e) => set('user', e.target.value)}
                    placeholder="postgres"
                    required
                    spellCheck={false}
                    value={state.user}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Password</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      autoComplete="new-password"
                      disabled={managed}
                      onChange={(e) => set('password', e.target.value)}
                      placeholder={connection?.hasPassword ? '•••••••• (unchanged)' : 'Password'}
                      type={showPassword ? 'text' : 'password'}
                      value={state.password}
                    />
                    <InputGroupAddon align="inline-end">
                      <Button
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        onClick={() => setShowPassword((v) => !v)}
                        size="icon-xs"
                        variant="ghost"
                      >
                        {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                      </Button>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
                <Field>
                  <FieldLabel>SSL</FieldLabel>
                  <Select
                    disabled={managed}
                    items={SSL_ITEMS}
                    onValueChange={(v) => v && set('ssl', v as SslMode)}
                    value={state.ssl}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {SSL_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              </div>
            </section>

            <section className="flex flex-col gap-4">
              <SectionTitle>SSH tunnel</SectionTitle>
              <Label className="cursor-pointer items-start justify-between gap-4 rounded-lg border bg-muted/40 p-3 font-normal">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium text-sm">
                    <NetworkIcon aria-hidden="true" className="size-3.5 opacity-72" />
                    Connect through SSH
                  </span>
                  <span className="text-muted-foreground text-xs">
                    For databases that are only reachable from a bastion or server.
                  </span>
                </span>
                <Switch checked={state.ssh} disabled={managed} onCheckedChange={(v) => set('ssh', v)} />
              </Label>

              {state.ssh && (
                <>
                  <div className="grid grid-cols-[1fr_7rem] gap-3">
                    <Field>
                      <FieldLabel>SSH host</FieldLabel>
                      <Input
                        disabled={managed}
                        onChange={(e) => set('sshHost', e.target.value)}
                        placeholder="bastion.example.com"
                        required
                        spellCheck={false}
                        value={state.sshHost}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Port</FieldLabel>
                      <Input
                        disabled={managed}
                        inputMode="numeric"
                        onChange={(e) => set('sshPort', e.target.value.replace(/\D/g, ''))}
                        placeholder="22"
                        value={state.sshPort}
                      />
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel>SSH user</FieldLabel>
                    <Input
                      autoComplete="off"
                      disabled={managed}
                      onChange={(e) => set('sshUser', e.target.value)}
                      placeholder="deploy"
                      required
                      spellCheck={false}
                      value={state.sshUser}
                    />
                  </Field>

                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-2 font-medium text-sm">Authentication</legend>
                    <SegmentedControl aria-label="Authentication" role="radiogroup">
                      {AUTH_ITEMS.map((item) => (
                        <SegmentedControlItem
                          aria-checked={state.sshAuth === item.value}
                          data-checked={state.sshAuth === item.value ? '' : undefined}
                          disabled={managed}
                          key={item.value}
                          onClick={() => set('sshAuth', item.value)}
                          role="radio"
                        >
                          {item.label}
                        </SegmentedControlItem>
                      ))}
                    </SegmentedControl>
                  </fieldset>

                  {state.sshAuth === 'password' ? (
                    <Field>
                      <FieldLabel>SSH password</FieldLabel>
                      <Input
                        autoComplete="new-password"
                        disabled={managed}
                        onChange={(e) => set('sshPassword', e.target.value)}
                        placeholder={savedPassword ? 'Leave empty to keep the saved one' : 'SSH password'}
                        type="password"
                        value={state.sshPassword}
                      />
                    </Field>
                  ) : savedKeyShown ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
                      <span>A key is saved.</span>
                      <span className="flex items-center gap-1">
                        <Button
                          disabled={managed}
                          onClick={() => setState((s) => ({ ...s, sshKeyReset: true, sshClearKey: false }))}
                          size="sm"
                          variant="link"
                        >
                          Replace
                        </Button>
                        <Button
                          disabled={managed}
                          onClick={() => setState((s) => ({ ...s, sshKeyReset: true, sshClearKey: true }))}
                          size="sm"
                          variant="link"
                        >
                          Remove
                        </Button>
                      </span>
                    </div>
                  ) : (
                    <>
                      <Field>
                        <div className="flex items-center justify-between gap-2">
                          <FieldLabel>Private key</FieldLabel>
                          <Button
                            disabled={managed}
                            onClick={() => keyFileInput.current?.click()}
                            size="xs"
                            variant="link"
                          >
                            Load from file
                          </Button>
                          <input
                            accept=".pem,.key,.txt,text/plain"
                            hidden
                            onChange={onKeyFile}
                            ref={keyFileInput}
                            tabIndex={-1}
                            type="file"
                          />
                        </div>
                        <Textarea
                          autoComplete="off"
                          // a pasted key is ~50 lines: keep the box small and let it scroll
                          className="font-mono [&_textarea]:max-h-28 [&_textarea]:text-xs"
                          disabled={managed}
                          onChange={(e) => set('sshKey', e.target.value)}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          rows={4}
                          spellCheck={false}
                          value={state.sshKey}
                        />
                        {keyInvalid && <FieldError>{SSH_KEY_MESSAGE}</FieldError>}
                      </Field>
                      <Field>
                        <FieldLabel>Passphrase (optional)</FieldLabel>
                        <Input
                          autoComplete="new-password"
                          disabled={managed}
                          onChange={(e) => set('sshPassphrase', e.target.value)}
                          type="password"
                          value={state.sshPassphrase}
                        />
                      </Field>
                    </>
                  )}

                  {savedSsh?.hostKey && (
                    <p className="text-muted-foreground text-xs">Host key {shortenMiddle(savedSsh.hostKey, 12)}</p>
                  )}
                </>
              )}
            </section>

            <section className="flex flex-col gap-4">
              <SectionTitle>Access</SectionTitle>
              <Label className="cursor-pointer items-start justify-between gap-4 rounded-lg border bg-muted/40 p-3 font-normal">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium text-sm">
                    <ShieldAlertIcon aria-hidden="true" className="size-3.5 opacity-72" />
                    Production
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Shows a red marker and asks before every change.
                  </span>
                </span>
                <Switch checked={state.production} disabled={managed} onCheckedChange={(v) => set('production', v)} />
              </Label>

              <Label className="cursor-pointer items-start justify-between gap-4 rounded-lg border bg-muted/40 p-3 font-normal">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium text-sm">
                    <LockIcon aria-hidden="true" className="size-3.5 opacity-72" />
                    Read-only mode
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Every session starts read-only. Great for production databases.
                  </span>
                </span>
                <Switch checked={state.readOnly} disabled={managed} onCheckedChange={(v) => set('readOnly', v)} />
              </Label>

              <Field>
                <FieldLabel>
                  <BotIcon aria-hidden="true" className="size-3.5 opacity-72" />
                  AI and API access
                </FieldLabel>
                <Select
                  disabled={managed}
                  items={AI_ACCESS_ITEMS}
                  onValueChange={(v) => v && set('aiAccess', v as AiAccess)}
                  value={state.aiAccess}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {AI_ACCESS_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldDescription>
                  {AI_ACCESS_ITEMS.find((item) => item.value === state.aiAccess)?.help}
                  {state.readOnly &&
                    state.aiAccess !== 'off' &&
                    ' This connection is read-only, so AI is read-only too.'}
                </FieldDescription>
              </Field>
            </section>

            {/* Always present, so testing never resizes (and re-centres) the dialog */}
            {test ? (
              <Alert variant={test.ok ? 'success' : 'error'}>
                {test.ok ? <CircleCheckIcon /> : <CircleAlertIcon />}
                <AlertTitle>{test.ok ? 'Connection successful' : 'Connection failed'}</AlertTitle>
                <TestSlotText>
                  {test.ok ? (
                    <>
                      {test.serverVersion
                        ? `PostgreSQL ${test.serverVersion} · ${test.latencyMs ?? '?'} ms`
                        : `Connected to ${state.host.trim()}:${state.port}`}
                      {test.hostKey && (
                        <>
                          <br />
                          SSH host key {test.hostKey}
                        </>
                      )}
                    </>
                  ) : (
                    test.error
                  )}
                </TestSlotText>
              </Alert>
            ) : (
              <Alert className="border-dashed text-muted-foreground">
                {testMutation.isPending ? <Spinner /> : <PlugZapIcon />}
                <AlertTitle>{testMutation.isPending ? 'Testing connection…' : 'Not tested yet'}</AlertTitle>
                <TestSlotText>
                  {testMutation.isPending
                    ? `Connecting to ${state.host || 'localhost'}:${state.port || '5432'}…`
                    : null}
                </TestSlotText>
              </Alert>
            )}
          </DialogPanel>
          <DialogFooter className="sm:justify-between">
            <Button
              disabled={!canSubmit}
              loading={testMutation.isPending}
              onClick={() => testMutation.mutate()}
              type="button"
              variant="outline"
            >
              <PlugZapIcon aria-hidden="true" />
              Test connection
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
              <Button disabled={!canSubmit || managed} loading={saveMutation.isPending} type="submit">
                {isEdit ? 'Save changes' : 'Save & connect'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{children}</h3>
}

const TEST_HINT = 'Use “Test connection” to check host, credentials and SSL before saving.'

/**
 * Test result text. The "not tested" hint is always laid out underneath (invisible
 * unless shown), so no state is taller than the first and the dialog never jumps.
 */
function TestSlotText({ children }: { children: ReactNode }) {
  const hasText = children != null && children !== ''
  return (
    <AlertDescription className="grid break-words *:col-start-1 *:row-start-1">
      <span aria-hidden={hasText || undefined} className={cn(hasText && 'invisible')}>
        {TEST_HINT}
      </span>
      {hasText && <span>{children}</span>}
    </AlertDescription>
  )
}
