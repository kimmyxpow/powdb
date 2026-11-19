import { useLayoutEffect } from 'react'

/** how many mounted copies of each floating bar are shown, by name */
const shown = new Map<string, number>()

/** lists the shown bars on <html> as `data-floating-bars="pending selection"` (CSS reads it; no :has) */
function publish() {
  const names = [...shown.keys()].sort().join(' ')
  if (names) document.documentElement.setAttribute('data-floating-bars', names)
  else document.documentElement.removeAttribute('data-floating-bars')
}

/**
 * Marks the document while a floating bar is shown, so the toasts can rise above it. Shows are
 * counted, so two bars at once (and each one's removal) are tracked separately.
 */
export function useFloatingBar(name: string, active: boolean) {
  useLayoutEffect(() => {
    if (!active) return
    shown.set(name, (shown.get(name) ?? 0) + 1)
    publish()
    return () => {
      const left = (shown.get(name) ?? 1) - 1
      if (left > 0) shown.set(name, left)
      else shown.delete(name)
      publish()
    }
  }, [name, active])
}
