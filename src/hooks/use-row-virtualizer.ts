import { useCallback, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { getRowRange, getRowWindow, getScrollTarget, getSlotCount, slotOf, type RowRange } from '../lib/virtual-range'

interface RowVirtualizerOptions {
  count: number
  /** fixed height of every row, in px */
  rowHeight: number
  /** extra rows rendered above and below the visible window */
  overscan: number
  /** the scrollable element; must stay mounted for the lifetime of the hook */
  scrollRef: RefObject<HTMLElement | null>
  /**
   * space above the first row inside the scroll element, e.g. a sticky header.
   * It also keeps scrollToIndex from hiding a row under that header.
   */
  paddingStart: number
}

/** viewport height assumed before the scroll element is measured (SSR, first render) */
const FALLBACK_VIEWPORT = 800

/** what the scroll position decides: the rows in view (unclamped) and how many row elements to keep */
interface View extends RowRange {
  slots: number
}

function measureView(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
  paddingStart: number,
): View {
  const visible = getRowRange({ scrollTop, viewportHeight, rowHeight, overscan: 0, paddingStart, count: Infinity })
  return { ...visible, slots: getSlotCount({ viewportHeight, rowHeight, overscan }) }
}

/**
 * Minimal fixed-height row virtualizer for a single scroll element.
 * Renders only the rows in view (plus overscan); `totalSize` is the full
 * scroll height, `items` the rows to render with their offsets.
 *
 * Row elements are recycled: a row's element is keyed by its slot (`index % slots`), not by the row.
 * The window has a fixed size, so scrolling only changes the index, and so the position and content,
 * of the slot whose row left the window. React then updates that element in place instead of
 * unmounting one and mounting another (inserting or removing elements makes Chrome restyle the page).
 * The slot count changes only with the viewport height.
 */
export function useRowVirtualizer({ count, rowHeight, overscan, scrollRef, paddingStart }: RowVirtualizerOptions) {
  // the scroll position as rows, kept unclamped; `count` is applied at render time instead
  const [view, setView] = useState<View>(() => measureView(0, FALLBACK_VIEWPORT, rowHeight, overscan, paddingStart))

  // re-reads the scroll element and stores the view only when it changes,
  // so scrolling does not re-render on every pixel
  const sync = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const next = measureView(el.scrollTop, el.clientHeight || FALLBACK_VIEWPORT, rowHeight, overscan, paddingStart)
    setView((prev) => (prev.start === next.start && prev.end === next.end && prev.slots === next.slots ? prev : next))
  }, [scrollRef, rowHeight, overscan, paddingStart])

  // measure after the first commit (and after the row count changes), before paint
  useLayoutEffect(() => {
    sync()
  }, [sync, count])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', sync, { passive: true })
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      observer.disconnect()
    }
  }, [scrollRef, sync])

  const rowWindow = getRowWindow(view, view.slots, count)
  // in slot order, so the elements stay in the same DOM order while the window moves
  const items: { index: number; slot: number; start: number }[] = []
  for (let index = rowWindow.start; index < rowWindow.end; index++) {
    items.push({ index, slot: slotOf(index, view.slots), start: paddingStart + index * rowHeight })
  }
  items.sort((a, b) => a.slot - b.slot)
  const totalSize = paddingStart + count * rowHeight

  // scrolls just enough to bring the row into view (no-op when it already is)
  const scrollToIndex = (index: number) => {
    const el = scrollRef.current
    if (!el) return
    const target = getScrollTarget({
      index,
      scrollTop: el.scrollTop,
      viewportHeight: el.clientHeight || FALLBACK_VIEWPORT,
      rowHeight,
      paddingStart,
      count,
    })
    if (target === null) return
    el.scrollTop = target
    sync()
  }

  return { items, totalSize, scrollToIndex }
}
