import { useState } from 'react'
import { emptyPending } from '@/components/table/pending'
import type { PendingChanges } from '@/components/table/pending'

interface History {
  past: PendingChanges[]
  present: PendingChanges
  future: PendingChanges[]
}

const LIMIT = 200

const emptyHistory = (): History => ({ past: [], present: emptyPending(), future: [] })

/**
 * Staged table changes with undo / redo. Every change that alters the staged set
 * is one step (a paste of many cells is one step too); saving or changing the
 * view starts a fresh history.
 */
export function usePendingHistory() {
  const [h, setH] = useState<History>(emptyHistory)

  const setPending = (updater: (p: PendingChanges) => PendingChanges) => {
    setH((s) => {
      const next = updater(s.present)
      if (next === s.present) return s
      return { past: [...s.past, s.present].slice(-LIMIT), present: next, future: [] }
    })
  }
  const undo = () => {
    setH((s) =>
      s.past.length
        ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1]!, future: [s.present, ...s.future] }
        : s,
    )
  }
  const redo = () => {
    setH((s) =>
      s.future.length ? { past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1) } : s,
    )
  }
  const reset = () => setH(emptyHistory())

  return { pending: h.present, setPending, undo, redo, reset, canUndo: h.past.length > 0, canRedo: h.future.length > 0 }
}

export type PendingHistory = ReturnType<typeof usePendingHistory>
