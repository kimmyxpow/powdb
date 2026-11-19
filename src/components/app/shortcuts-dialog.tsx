import { useLocation } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { isMac } from '@/hooks/use-hotkey'
import { cn } from '@/lib/utils'

type TabId = 'general' | 'table' | 'sql'

/** A key combination is a list of keys, e.g. ['Mod', 'Shift', 'Z']. Modifiers: Mod, Alt, Shift. */
type Combo = string[]
type Row = { label: string; keys: Combo[] }
type Group = { title?: string; rows: Row[] }
type Section = { id: TabId; tab: string; title: string; groups: Group[] }

const SECTIONS: Section[] = [
  {
    id: 'general',
    tab: 'General',
    title: 'General',
    groups: [
      {
        rows: [
          { label: 'Search tables, views and actions', keys: [['Mod', 'K']] },
          { label: 'Filter the sidebar', keys: [['/']] },
          { label: 'Show keyboard shortcuts', keys: [['?']] },
          { label: 'Show or hide the sidebar', keys: [['Mod', 'B']] },
        ],
      },
    ],
  },
  {
    id: 'table',
    tab: 'Table',
    title: 'Table',
    groups: [
      {
        title: 'Moving around',
        rows: [
          { label: 'Move between cells', keys: [['↑'], ['↓'], ['←'], ['→']] },
          { label: 'Go to the first row', keys: [['Mod', '↑']] },
          { label: 'Go to the last row', keys: [['Mod', '↓']] },
          { label: 'Go to the first column', keys: [['Home']] },
          { label: 'Go to the last column', keys: [['End']] },
          { label: 'One screen up', keys: [['PageUp']] },
          { label: 'One screen down', keys: [['PageDown']] },
          { label: 'Next cell', keys: [['Tab']] },
          { label: 'Previous cell', keys: [['Shift', 'Tab']] },
          { label: 'Open or close row details', keys: [['Space']] },
          { label: 'Search rows', keys: [['Mod', 'F']] },
          { label: 'Refresh the rows', keys: [['Alt', 'Shift', 'R']] },
        ],
      },
      {
        title: 'Editing',
        rows: [
          { label: 'Edit the cell (or just start typing)', keys: [['Enter'], ['F2']] },
          { label: 'Open the calendar or large editor', keys: [['Shift', 'Enter']] },
          { label: 'Show or hide the calendar', keys: [['Alt', '↓']] },
          { label: 'Keep the edit and go down', keys: [['Enter']] },
          { label: 'Keep the edit and go right', keys: [['Tab']] },
          { label: 'Cancel the edit', keys: [['Esc']] },
          { label: 'Set the cell to NULL, or delete the selected rows', keys: [['Delete']] },
          { label: 'Copy the cell or selected rows', keys: [['Mod', 'C']] },
          { label: 'Paste from a spreadsheet', keys: [['Mod', 'V']] },
          { label: 'Select all rows', keys: [['Mod', 'A']] },
          { label: 'Add a row', keys: [['Alt', 'Shift', 'N']] },
          { label: 'Duplicate the row', keys: [['Alt', 'Shift', 'D']] },
          { label: 'Delete the row or selected rows', keys: [['Mod', 'Delete']] },
          { label: 'Undo', keys: [['Mod', 'Z']] },
          {
            label: 'Redo',
            keys: [
              ['Mod', 'Shift', 'Z'],
              ['Mod', 'Y'],
            ],
          },
          { label: 'Save changes', keys: [['Mod', 'S']] },
          { label: 'Clear the selection', keys: [['Esc']] },
        ],
      },
    ],
  },
  {
    id: 'sql',
    tab: 'SQL editor',
    title: 'SQL editor',
    groups: [
      {
        rows: [
          { label: 'Run the selection or the whole script', keys: [['Mod', 'Enter']] },
          { label: 'Run the statement at the cursor', keys: [['Mod', 'Shift', 'Enter']] },
          { label: 'Cancel the running query', keys: [['Mod', '.']] },
          { label: 'Save query', keys: [['Mod', 'S']] },
          { label: 'Format SQL', keys: [['Shift', 'Alt', 'F']] },
          { label: 'Show suggestions', keys: [['Ctrl', 'Space']] },
          { label: 'Accept a suggestion', keys: [['Tab']] },
          { label: 'Comment or uncomment lines', keys: [['Mod', '/']] },
        ],
      },
    ],
  },
]

const MODIFIER_SYMBOLS: Record<string, string> = isMac
  ? { Ctrl: '⌃', Mod: '⌘', Alt: '⌥', Shift: '⇧' }
  : { Ctrl: 'Ctrl', Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }

/** Native Mac order for modifiers is ⌃ ⌥ ⇧ ⌘ (e.g. ⇧⌘Z). */
const MAC_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod']

function displayKeys(keys: Combo): string[] {
  if (!isMac) return keys.map((k) => MODIFIER_SYMBOLS[k] ?? k)
  const modifiers = MAC_MODIFIER_ORDER.filter((m) => keys.includes(m)).map((m) => MODIFIER_SYMBOLS[m] ?? m)
  const rest = keys.filter((k) => !(k in MODIFIER_SYMBOLS))
  return [...modifiers, ...rest]
}

function ComboKeys({ keys }: { keys: Combo }) {
  return (
    <KbdGroup className={isMac ? 'gap-0.5' : 'gap-1'}>
      {displayKeys(keys).map((k, i) => (
        <Fragment key={`${k}-${i}`}>
          {i > 0 && !isMac && (
            <span aria-hidden="true" className="text-muted-foreground text-xs">
              +
            </span>
          )}
          <Kbd>{k}</Kbd>
        </Fragment>
      ))}
    </KbdGroup>
  )
}

function Keys({ alternatives }: { alternatives: Combo[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {alternatives.map((combo, i) => (
        <Fragment key={combo.join('+')}>
          {i > 0 && <span className="text-muted-foreground text-xs">or</span>}
          <ComboKeys keys={combo} />
        </Fragment>
      ))}
    </span>
  )
}

function ShortcutList({ rows }: { rows: Row[] }) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border">
      {rows.map((row) => (
        <li className="flex h-10 items-center justify-between gap-3 px-3" key={row.label}>
          <span className="min-w-0 truncate text-sm">{row.label}</span>
          <Keys alternatives={row.keys} />
        </li>
      ))}
    </ul>
  )
}

/** `title` only in search results: inside a tab the tab already names the section. */
function SectionBlock({ title, groups }: { title?: string; groups: Group[] }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h3 className="px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>}
      <div className="flex flex-col gap-5">
        {groups.map((group, i) => (
          <div className="flex flex-col gap-2" key={group.title ?? i}>
            {group.title && <h4 className="px-1 text-muted-foreground text-xs">{group.title}</h4>}
            <ShortcutList rows={group.rows} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Table pages open on Table, the SQL editor page on SQL editor, everything else on General. */
function tabForPath(pathname: string): TabId {
  if (pathname.includes('/t/')) return 'table'
  if (/\/sql\/?$/.test(pathname)) return 'sql'
  return 'general'
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const initialTab = tabForPath(pathname)
  const [tab, setTab] = useState<TabId>(initialTab)
  const [query, setQuery] = useState('')

  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTab(initialTab)
      setQuery('')
    }
  }

  const needle = query.trim().toLowerCase()
  const searching = needle !== ''
  const current = SECTIONS.find((s) => s.id === tab)!
  const matches: Section[] = searching
    ? SECTIONS.map((s) => ({
        ...s,
        groups: [{ rows: s.groups.flatMap((g) => g.rows).filter((r) => r.label.toLowerCase().includes(needle)) }],
      })).filter((s) => s.groups[0]!.rows.length > 0)
    : []

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? anywhere outside a text field to open this list.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 px-4 pb-6 sm:px-6">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search shortcuts"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts"
              spellCheck={false}
              value={query}
            />
          </InputGroup>
          <Tabs className="gap-4" onValueChange={(v) => setTab(v as TabId)} value={tab}>
            {/* Hidden (not removed) while searching so the dialog keeps its height. */}
            <TabsList className={cn(searching && 'invisible')} inert={searching}>
              {SECTIONS.map((s) => (
                <TabsTab key={s.id} value={s.id}>
                  {s.tab}
                </TabsTab>
              ))}
            </TabsList>
            <div
              className="scrollbar-thin h-[min(28rem,calc(100dvh-16rem))] overflow-y-auto"
              key={searching ? 'search' : tab}
            >
              {searching ? (
                matches.length > 0 ? (
                  <div className="flex flex-col gap-6 pb-1">
                    {matches.map((s) => (
                      <SectionBlock groups={s.groups} key={s.id} title={s.title} />
                    ))}
                  </div>
                ) : (
                  <p className="py-10 text-center text-muted-foreground text-sm">No shortcuts match</p>
                )
              ) : (
                <TabsPanel value={tab}>
                  <SectionBlock groups={current.groups} />
                </TabsPanel>
              )}
            </div>
          </Tabs>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
