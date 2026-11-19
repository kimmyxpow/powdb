/**
 * Pure math for a fixed-height row virtualizer.
 *
 * Layout: the scroll content starts with `paddingStart` pixels (e.g. a sticky
 * header that lives inside the scroll element), then `count` rows of
 * `rowHeight` pixels each. Row `i` spans [paddingStart + i * rowHeight, ...).
 */

interface RowRangeInput {
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  overscan: number
  /** space above the first row (sticky header height) */
  paddingStart: number
  /** number of rows; `Number.POSITIVE_INFINITY` yields the unclamped range */
  count: number
}

/** half-open index range [start, end) */
export interface RowRange {
  start: number
  end: number
}

export function getRowRange({
  scrollTop,
  viewportHeight,
  rowHeight,
  overscan,
  paddingStart,
  count,
}: RowRangeInput): RowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const maxScroll = Math.max(0, paddingStart + count * rowHeight - viewportHeight)
  const top = Math.max(0, Math.min(scrollTop, maxScroll) - paddingStart)
  const bottom = Math.max(0, Math.min(scrollTop, maxScroll) + viewportHeight - paddingStart)
  const first = Math.floor(top / rowHeight)
  const last = Math.ceil(bottom / rowHeight) // exclusive
  const start = Math.min(Math.max(0, first - overscan), count)
  const end = Math.min(count, Math.max(start, last + overscan))
  return { start, end }
}

/**
 * Row elements a viewport needs. At most ceil(v) + 1 rows overlap a viewport of v rows, so
 * ceil(v) + 2 + 2 * overscan slots always hold the visible rows with `overscan` rows to spare on each side.
 */
export function getSlotCount({
  viewportHeight,
  rowHeight,
  overscan,
}: {
  viewportHeight: number
  rowHeight: number
  overscan: number
}): number {
  if (rowHeight <= 0) return 1
  return Math.max(1, Math.ceil(viewportHeight / rowHeight) + 2 + 2 * overscan)
}

/**
 * The rows to render: `slots` consecutive indices (fewer when there are fewer rows), centred on the
 * visible range and kept inside [0, count). Because the window keeps its size, moving it by one row
 * changes the index of exactly one slot (see `slotOf`), so the other row elements are not touched.
 */
export function getRowWindow(visible: RowRange, slots: number, count: number): RowRange {
  const size = Math.max(0, Math.min(count, slots))
  if (size === 0) return { start: 0, end: 0 }
  const lead = Math.floor((size - (visible.end - visible.start)) / 2)
  const start = Math.min(Math.max(0, visible.start - lead), count - size)
  return { start, end: start + size }
}

/**
 * The slot (row element) a row is drawn in. A row keeps its slot for as long as its index is
 * unchanged, however the window moves. Rows of one window get distinct slots when the window
 * holds at most `slots` rows.
 */
export function slotOf(index: number, slots: number): number {
  return index % slots
}

interface ScrollTargetInput {
  index: number
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  /** space above the first row; a row is never scrolled underneath it */
  paddingStart: number
  count: number
}

/**
 * The scrollTop that brings row `index` into view, or `null` when the row is already
 * fully visible (below the sticky header). The result is clamped to the scrollable range.
 */
export function getScrollTarget({
  index,
  scrollTop,
  viewportHeight,
  rowHeight,
  paddingStart,
  count,
}: ScrollTargetInput): number | null {
  if (count <= 0) return null
  // a row index from a render that is just being corrected may be past the end
  const row = Math.min(index, count - 1)
  const itemStart = paddingStart + row * rowHeight
  const itemEnd = itemStart + rowHeight
  const maxScroll = Math.max(0, paddingStart + count * rowHeight - viewportHeight)
  let target: number
  if (itemEnd >= scrollTop + viewportHeight) target = itemEnd - viewportHeight
  else if (itemStart <= scrollTop + paddingStart) target = itemStart - paddingStart
  else return null
  return Math.max(0, Math.min(target, maxScroll))
}
