import { useState } from 'react'
import type { ReactNode } from 'react'
import { AccountSettings } from '@/components/app/settings-account'
import { UpdateDialog, useAvailableUpdate } from '@/components/app/update-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { useAppStore } from '@/lib/store'
import { setTheme, useTheme } from '@/lib/theme'
import type { Theme } from '@/lib/theme'
import { localZoneName } from '@/lib/time'
import { APP_VERSION } from '@/lib/version'

const PAGE_SIZES = [50, 100, 250, 500, 1000]
const MAX_ROWS = [100, 500, 1000, 5000, 10000]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>
      <div className="flex flex-col divide-y rounded-xl border">{children}</div>
    </section>
  )
}

/** One setting: what it does on the left, its control on the right. `toggle`: the whole row is the switch's label. */
function Row({
  label,
  hint,
  children,
  toggle = false,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  toggle?: boolean
}) {
  const text = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="font-medium text-sm">{label}</span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </span>
  )
  return toggle ? (
    <Label className="flex cursor-pointer items-center justify-between gap-6 px-3.5 py-3 font-normal">
      {text}
      {children}
    </Label>
  ) : (
    <div className="flex items-center justify-between gap-6 px-3.5 py-3">
      {text}
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Choice<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
}) {
  return (
    <SegmentedControl aria-label={label} role="radiogroup" size="sm">
      {options.map((o) => (
        <SegmentedControlItem
          aria-checked={value === o.value}
          data-checked={value === o.value ? '' : undefined}
          key={o.value}
          onClick={() => onChange(o.value)}
          role="radio"
        >
          {o.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  )
}

function NumberSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: number
  onChange: (n: number) => void
  options: number[]
  label: string
}) {
  return (
    <Select
      items={options.map((n) => ({ label: n.toLocaleString(), value: n }))}
      onValueChange={(v) => onChange(v as number)}
      value={value}
    >
      <SelectTrigger aria-label={label} className="w-28 min-w-0" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((n) => (
          <SelectItem key={n} value={n}>
            {n.toLocaleString()}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}

type SettingsTab = 'general' | 'account'

/** Every tab uses the same height, so switching tabs never moves the dialog. Each scrolls inside. */
// the content fills the panel, so the account form's button can sit at the bottom
const PANEL = 'flex-none min-h-0 [&_[data-slot=scroll-area-content]]:h-full'
const PANEL_HEIGHT = { height: 'min(36rem, calc(100svh - 13rem))' }

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<SettingsTab>('general')
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Your preferences and account.</DialogDescription>
        </DialogHeader>
        <Tabs className="min-h-0 gap-4" onValueChange={(v) => setTab(v as SettingsTab)} value={tab}>
          <div className="px-6">
            <TabsList>
              <TabsTab value="general">General</TabsTab>
              <TabsTab value="account">Account</TabsTab>
            </TabsList>
          </div>
          <TabsPanel className={PANEL} style={PANEL_HEIGHT} value="general">
            <GeneralSettings />
          </TabsPanel>
          <TabsPanel className={PANEL} style={PANEL_HEIGHT} value="account">
            <DialogPanel className="flex h-full flex-col gap-6">
              <AccountSettings />
            </DialogPanel>
          </TabsPanel>
        </Tabs>
      </DialogPopup>
    </Dialog>
  )
}

function GeneralSettings() {
  const s = useAppStore()
  const { theme } = useTheme()
  return (
    <DialogPanel className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">Saved in this browser and used for every connection.</p>
      <Section title="Tables">
        <Row
          hint="Click a cell to see its whole row next to the table, on wide screens. When off, use the panel icon on a row or press Space."
          label="Open row details on click"
          toggle
        >
          <Switch checked={s.openRowOnClick} onCheckedChange={s.setOpenRowOnClick} />
        </Row>
        <Row hint="For tables you open from now on." label="Rows per page">
          <NumberSelect label="Rows per page" onChange={s.setPageSize} options={PAGE_SIZES} value={s.pageSize} />
        </Row>
      </Section>

      <Section title="Dates and times">
        <Row hint="For values with a time zone (timestamptz)." label="Show times in">
          <Choice
            label="Show times in"
            onChange={s.setTimeZoneMode}
            options={[
              { value: 'local', label: `Your time (${localZoneName()})` },
              { value: 'utc', label: 'As stored' },
            ]}
            value={s.timeZoneMode}
          />
        </Row>
        <Row hint="12:30:05.123456 instead of 12:30:05." label="Show microseconds" toggle>
          <Switch checked={s.showFractionalSeconds} onCheckedChange={s.setShowFractionalSeconds} />
        </Row>
      </Section>

      <Section title="SQL editor">
        <Row hint="Only the first rows are shown. The query itself still runs in full." label="Rows shown per result">
          <NumberSelect label="Rows shown per result" onChange={s.setMaxRows} options={MAX_ROWS} value={s.maxRows} />
        </Row>
      </Section>

      <Section title="Appearance">
        <Row label="Theme">
          <Choice<Theme>
            label="Theme"
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
            value={theme}
          />
        </Row>
      </Section>

      <Section title="About">
        <Row label="Version">
          <VersionValue />
        </Row>
      </Section>
    </DialogPanel>
  )
}

/** The running version, and a button when a newer release is out. The button opens the same dialog as the header notice. */
function VersionValue() {
  const update = useAvailableUpdate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <span className="flex items-center gap-2">
        {update && (
          <Button onClick={() => setOpen(true)} size="sm" variant="outline">
            Update to {update.latest.version}
          </Button>
        )}
        <span className="font-mono text-sm tabular-nums">{APP_VERSION}</span>
      </span>
      {update && <UpdateDialog onOpenChange={setOpen} open={open} update={update} />}
    </>
  )
}
