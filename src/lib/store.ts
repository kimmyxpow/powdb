import { create, persist } from '@/lib/create-store'
import type { RelationKind } from './types'

export interface SqlTab {
  id: string
  name: string
  sql: string
  createdAt: number
  /** the saved query this tab is linked to (see saved-queries) */
  savedId?: string
  /** the saved SQL as last saved or opened; the tab shows a dot while sql differs from it */
  savedSql?: string
}

export interface SqlWorkspace {
  tabs: SqlTab[]
  activeId: string
}

interface HistoryItem {
  id: string
  sql: string
  database: string
  at: number
  durationMs: number
  ok: boolean
  rows: number | null
  error?: string
}

export interface RecentItem {
  schema: string
  name: string
  kind: RelationKind
  at: number
}

interface AppState {
  sql: Record<string, SqlWorkspace>
  history: Record<string, HistoryItem[]>
  schemaSelection: Record<string, string>
  recent: Record<string, RecentItem[]>
  collapsedGroups: Record<string, boolean>
  pageSize: number
  maxRows: number
  /** how timestamptz values are shown in the grid: in the browser's time zone, or as stored (UTC) */
  timeZoneMode: 'local' | 'utc'
  showFractionalSeconds: boolean
  /** "conn:db:schema.table" → column names hidden in the grid */
  hiddenColumns: Record<string, string[]>
  /** clicking a row opens its details next to the grid (wide screens) */
  openRowOnClick: boolean
  /** the update version the user dismissed: the sidebar notice stays hidden for this version only */
  dismissedUpdate: string | null

  openSqlTab: (connectionId: string, sql?: string, name?: string) => string
  /** Switches to the tab linked to this saved query, or opens one in the workspace. */
  openSavedQuery: (connectionId: string, query: { id: string; name: string; sql: string }) => string
  updateSqlTab: (connectionId: string, tabId: string, patch: Partial<Omit<SqlTab, 'id'>>) => void
  closeSqlTab: (connectionId: string, tabId: string) => void
  setActiveSqlTab: (connectionId: string, tabId: string) => void
  addHistory: (connectionId: string, item: Omit<HistoryItem, 'id'>) => void
  clearHistory: (connectionId: string) => void
  setSchema: (key: string, schema: string) => void
  pushRecent: (key: string, item: Omit<RecentItem, 'at'>) => void
  setGroupCollapsed: (group: string, collapsed: boolean) => void
  setPageSize: (n: number) => void
  setMaxRows: (n: number) => void
  setTimeZoneMode: (mode: 'local' | 'utc') => void
  setShowFractionalSeconds: (v: boolean) => void
  setHiddenColumns: (key: string, names: string[]) => void
  setOpenRowOnClick: (v: boolean) => void
  setDismissedUpdate: (version: string | null) => void
}

const newId = () => Math.random().toString(36).slice(2, 10)

function defaultWorkspace(): SqlWorkspace {
  const tab: SqlTab = {
    id: newId(),
    name: 'Query 1',
    sql: '',
    createdAt: Date.now(),
  }
  return { tabs: [tab], activeId: tab.id }
}

function nextName(tabs: SqlTab[]): string {
  let n = tabs.length + 1
  const names = new Set(tabs.map((t) => t.name))
  while (names.has(`Query ${n}`)) n++
  return `Query ${n}`
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      sql: {},
      history: {},
      schemaSelection: {},
      recent: {},
      collapsedGroups: {},
      pageSize: 100,
      maxRows: 1000,
      timeZoneMode: 'local',
      showFractionalSeconds: false,
      hiddenColumns: {},
      openRowOnClick: false,
      dismissedUpdate: null,

      openSqlTab: (connectionId, sql, name) => {
        const ws = get().sql[connectionId] ?? defaultWorkspace()
        const active = ws.tabs.find((t) => t.id === ws.activeId)
        // Reuse an untouched, empty tab instead of piling up new ones.
        if (sql !== undefined && active && !active.sql.trim()) {
          const tabs = ws.tabs.map((t) => (t.id === active.id ? { ...t, sql, name: name ?? t.name } : t))
          set({ sql: { ...get().sql, [connectionId]: { tabs, activeId: active.id } } })
          return active.id
        }
        const tab: SqlTab = {
          id: newId(),
          name: name ?? nextName(ws.tabs),
          sql: sql ?? '',
          createdAt: Date.now(),
        }
        set({
          sql: { ...get().sql, [connectionId]: { tabs: [...ws.tabs, tab], activeId: tab.id } },
        })
        return tab.id
      },

      openSavedQuery: (connectionId, query) => {
        const ws = get().sql[connectionId] ?? defaultWorkspace()
        const linked = ws.tabs.find((t) => t.savedId === query.id)
        if (linked) {
          set({ sql: { ...get().sql, [connectionId]: { ...ws, activeId: linked.id } } })
          return linked.id
        }
        const active = ws.tabs.find((t) => t.id === ws.activeId)
        const link = { savedId: query.id, savedSql: query.sql, name: query.name, sql: query.sql }
        // Reuse an untouched, unlinked empty tab, like openSqlTab does.
        if (active && !active.sql.trim() && !active.savedId) {
          const tabs = ws.tabs.map((t) => (t.id === active.id ? { ...t, ...link } : t))
          set({ sql: { ...get().sql, [connectionId]: { tabs, activeId: active.id } } })
          return active.id
        }
        const tab: SqlTab = { id: newId(), createdAt: Date.now(), ...link }
        set({
          sql: { ...get().sql, [connectionId]: { tabs: [...ws.tabs, tab], activeId: tab.id } },
        })
        return tab.id
      },

      updateSqlTab: (connectionId, tabId, patch) => {
        const ws = get().sql[connectionId] ?? defaultWorkspace()
        set({
          sql: {
            ...get().sql,
            [connectionId]: {
              ...ws,
              tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
            },
          },
        })
      },

      closeSqlTab: (connectionId, tabId) => {
        const ws = get().sql[connectionId] ?? defaultWorkspace()
        const index = ws.tabs.findIndex((t) => t.id === tabId)
        let tabs = ws.tabs.filter((t) => t.id !== tabId)
        if (tabs.length === 0) tabs = defaultWorkspace().tabs
        const activeId = ws.activeId === tabId ? tabs[Math.max(0, index - 1)]!.id : ws.activeId
        set({ sql: { ...get().sql, [connectionId]: { tabs, activeId } } })
      },

      setActiveSqlTab: (connectionId, tabId) => {
        const ws = get().sql[connectionId] ?? defaultWorkspace()
        set({ sql: { ...get().sql, [connectionId]: { ...ws, activeId: tabId } } })
      },

      addHistory: (connectionId, item) => {
        const list = get().history[connectionId] ?? []
        const filtered = list[0]?.sql === item.sql ? list.slice(1) : list
        set({
          history: {
            ...get().history,
            // keep localStorage small: cap entries and very long scripts
            [connectionId]: [
              {
                ...item,
                sql: item.sql.length > 20_000 ? `${item.sql.slice(0, 20_000)}\n-- (truncated)` : item.sql,
                id: newId(),
              },
              ...filtered,
            ].slice(0, 200),
          },
        })
      },

      clearHistory: (connectionId) => {
        set({ history: { ...get().history, [connectionId]: [] } })
      },

      setSchema: (key, schema) => {
        if (get().schemaSelection[key] === schema) return
        set({ schemaSelection: { ...get().schemaSelection, [key]: schema } })
      },

      pushRecent: (key, item) => {
        const list = (get().recent[key] ?? []).filter((r) => !(r.schema === item.schema && r.name === item.name))
        set({
          recent: { ...get().recent, [key]: [{ ...item, at: Date.now() }, ...list].slice(0, 8) },
        })
      },

      setGroupCollapsed: (group, collapsed) => {
        set({ collapsedGroups: { ...get().collapsedGroups, [group]: collapsed } })
      },

      setPageSize: (n) => set({ pageSize: n }),
      setMaxRows: (n) => set({ maxRows: n }),
      setTimeZoneMode: (mode) => set({ timeZoneMode: mode }),
      setShowFractionalSeconds: (v) => set({ showFractionalSeconds: v }),
      setOpenRowOnClick: (v) => set({ openRowOnClick: v }),
      setDismissedUpdate: (version) => set({ dismissedUpdate: version }),
      setHiddenColumns: (key, names) => {
        const next = { ...get().hiddenColumns }
        if (names.length) next[key] = names
        else delete next[key]
        set({ hiddenColumns: next })
      },
    }),
    {
      name: 'powdb-state',
    },
  ),
)

/** Ensure a workspace exists for the connection (so tab ids are stable). */
export function ensureWorkspace(connectionId: string): SqlWorkspace {
  const state = useAppStore.getState()
  const existing = state.sql[connectionId]
  if (existing) return existing
  const ws = defaultWorkspace()
  useAppStore.setState({ sql: { ...state.sql, [connectionId]: ws } })
  return ws
}
