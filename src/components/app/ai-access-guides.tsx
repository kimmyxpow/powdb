import { useState } from 'react'
import { CopyButton } from '@/components/app/copy-button'
import { Field, FieldLabel } from '@/components/ui/field'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import {
  DEFAULT_CLIENT_ID,
  MCP_CLIENTS,
  PLACEHOLDER_TOKEN,
  aiDockerPrompt,
  aiPrompt,
  mcpUrl,
  resolveSetup,
} from '@/lib/mcp-clients'
import type { SetupMode } from '@/lib/mcp-clients'

type Tab = 'ask' | 'manual'

const MODE_LABELS: Record<SetupMode, string> = {
  http: 'With a token (HTTP)',
  docker: 'Without a token (Docker)',
}

const TOOL_KEY = 'powview.ai-access.tool'

/** Same height on both sub-tabs, so switching tabs, tools or methods never resizes the dialog. */
const PANEL = 'h-[min(30rem,calc(100dvh-18rem))] flex-none overflow-y-auto'

const CODE =
  'whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed'

function readStoredTool(): string {
  try {
    const id = window.localStorage.getItem(TOOL_KEY)
    if (id && MCP_CLIENTS.some((c) => c.id === id)) return id
  } catch {
    // storage can be blocked; the default tool is fine
  }
  return DEFAULT_CLIENT_ID
}

function storeTool(id: string) {
  try {
    window.localStorage.setItem(TOOL_KEY, id)
  } catch {
    // not remembered; nothing else depends on it
  }
}

/**
 * Get an AI tool connected: ask the AI to set itself up ("Ask your AI" sub-tab), or follow
 * a guide. With a token that is the HTTP setup; without one, the Docker command. The method
 * switch appears only when more than one method is allowed.
 */
export function ConnectSection({ token, modes }: { token: string | null; modes: SetupMode[] }) {
  const [tab, setTab] = useState<Tab>('ask')
  const [toolId, setToolId] = useState(readStoredTool)
  const [mode, setMode] = useState<SetupMode>(modes[0]!)

  const url = mcpUrl()
  const shownToken = token ?? PLACEHOLDER_TOKEN
  const client = MCP_CLIENTS.find((c) => c.id === toolId)!
  const setup = resolveSetup(client, mode, url, shownToken)
  // without a token the only way in is the Docker command, so the prompt asks for that
  const hasToken = token !== null
  const prompt = hasToken ? aiPrompt(url, shownToken) : aiDockerPrompt()

  const guide = (
    <div className="flex flex-col gap-5">
      <div className={modes.length > 1 ? 'grid gap-4 sm:grid-cols-2' : 'flex flex-col gap-4'}>
        <Field>
          <FieldLabel>Your tool</FieldLabel>
          <Select
            items={MCP_CLIENTS.map((c) => ({ label: c.name, value: c.id }))}
            onValueChange={(v) => {
              if (!v) return
              setToolId(v as string)
              storeTool(v as string)
            }}
            value={toolId}
          >
            <SelectTrigger aria-label="Your tool">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {MCP_CLIENTS.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        {modes.length > 1 && (
          <Field>
            <FieldLabel>Method</FieldLabel>
            <SegmentedControl aria-label="Method" role="radiogroup">
              {modes.map((m) => (
                <SegmentedControlItem
                  aria-checked={mode === m}
                  data-checked={mode === m ? '' : undefined}
                  key={m}
                  onClick={() => setMode(m)}
                  role="radio"
                >
                  {MODE_LABELS[m]}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm">{setup.kind === 'command' ? setup.where : `Add this to ${setup.where}`}</p>
          <CopyButton label="Copy setup" text={setup.code} />
        </div>
        <pre className={CODE}>{setup.code}</pre>
        {setup.note && <p className="text-muted-foreground text-sm">{setup.note}</p>}
      </div>
    </div>
  )

  return (
    <section className="flex flex-col gap-3">
      <Tabs className="gap-3" onValueChange={(v) => setTab(v as Tab)} value={tab}>
        <TabsList>
          <TabsTab value="ask">Ask your AI</TabsTab>
          <TabsTab value="manual">Set it up yourself</TabsTab>
        </TabsList>

        <TabsPanel className={PANEL} value="ask">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">Paste this into your AI tool. It will add PowView to its own settings.</p>
              <CopyButton label="Copy prompt" size="lg" text={prompt}>
                Copy prompt
              </CopyButton>
            </div>
            <pre className={CODE}>{prompt}</pre>
            {hasToken && (
              <p className="text-muted-foreground text-sm">
                The prompt contains your token. Only paste it into a tool you trust.
              </p>
            )}
          </div>
        </TabsPanel>

        <TabsPanel className={PANEL} value="manual">
          {guide}
        </TabsPanel>
      </Tabs>
    </section>
  )
}
