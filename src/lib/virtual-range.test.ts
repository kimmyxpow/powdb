import { describe, expect, test } from 'bun:test'
import { getRowRange, getRowWindow, getScrollTarget, getSlotCount, slotOf } from './virtual-range'

const H = 32
const PAD = 34

describe('getRowRange', () => {
  test('top of a long list, no overscan', () => {
    expect(
      getRowRange({ scrollTop: 0, viewportHeight: 300, rowHeight: H, overscan: 0, paddingStart: PAD, count: 1000 }),
    ).toEqual({ start: 0, end: 9 })
  })

  test('middle of a long list with overscan', () => {
    // rows visible: (1000-34)/32 = 30.2 .. (1300-34)/32 = 39.6 -> first 30, last 40 (exclusive)
    expect(
      getRowRange({ scrollTop: 1000, viewportHeight: 300, rowHeight: H, overscan: 5, paddingStart: PAD, count: 1000 }),
    ).toEqual({ start: 25, end: 45 })
  })

  test('bottom of the list is clamped to count', () => {
    const r = getRowRange({
      scrollTop: 1e9,
      viewportHeight: 300,
      rowHeight: H,
      overscan: 12,
      paddingStart: PAD,
      count: 1000,
    })
    expect(r.end).toBe(1000)
    expect(r.start).toBeLessThan(r.end)
    expect(r.end - r.start).toBeGreaterThan(0)
  })

  test('scrolled to the very bottom shows the last rows', () => {
    const total = PAD + 1000 * H
    const r = getRowRange({
      scrollTop: total - 300,
      viewportHeight: 300,
      rowHeight: H,
      overscan: 0,
      paddingStart: PAD,
      count: 1000,
    })
    expect(r.end).toBe(1000)
    expect(r.start).toBeLessThanOrEqual(999)
  })

  test('empty list', () => {
    expect(
      getRowRange({ scrollTop: 0, viewportHeight: 300, rowHeight: H, overscan: 12, paddingStart: PAD, count: 0 }),
    ).toEqual({ start: 0, end: 0 })
  })

  test('count smaller than the viewport returns every row', () => {
    expect(
      getRowRange({ scrollTop: 0, viewportHeight: 800, rowHeight: H, overscan: 12, paddingStart: PAD, count: 3 }),
    ).toEqual({ start: 0, end: 3 })
  })

  test('overscan is clamped at both ends', () => {
    expect(
      getRowRange({ scrollTop: 0, viewportHeight: 100, rowHeight: H, overscan: 50, paddingStart: 0, count: 500 }).start,
    ).toBe(0)
    // deepest scroll is 500 * 32 - 100 = 15900, first visible row 496, overscan 50 -> start 446
    const r = getRowRange({
      scrollTop: 16000,
      viewportHeight: 100,
      rowHeight: H,
      overscan: 50,
      paddingStart: 0,
      count: 500,
    })
    expect(r).toEqual({ start: 446, end: 500 })
  })

  test('scrollTop past the content is clamped to the last viewport', () => {
    const r = getRowRange({
      scrollTop: 999999,
      viewportHeight: 320,
      rowHeight: H,
      overscan: 0,
      paddingStart: 0,
      count: 100,
    })
    expect(r).toEqual({ start: 90, end: 100 })
  })

  test('unclamped count keeps the real window', () => {
    expect(
      getRowRange({
        scrollTop: 0,
        viewportHeight: 320,
        rowHeight: H,
        overscan: 0,
        paddingStart: 0,
        count: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ start: 0, end: 10 })
  })

  test('zero-height viewport yields an empty visible window plus overscan', () => {
    const r = getRowRange({ scrollTop: 0, viewportHeight: 0, rowHeight: H, overscan: 2, paddingStart: 0, count: 50 })
    expect(r).toEqual({ start: 0, end: 2 })
  })
})

describe('getScrollTarget', () => {
  const base = { rowHeight: H, paddingStart: PAD, viewportHeight: 300, count: 1000 }

  test('a row below the viewport scrolls so it is the last visible row', () => {
    expect(getScrollTarget({ ...base, index: 20, scrollTop: 0 })).toBe(706 - 300)
  })

  test('a row above the viewport scrolls so it sits under the header', () => {
    expect(getScrollTarget({ ...base, index: 5, scrollTop: 500 })).toBe(PAD + 5 * H - PAD)
  })

  test('a row fully inside the viewport does not scroll', () => {
    expect(getScrollTarget({ ...base, index: 6, scrollTop: 100 })).toBeNull()
  })

  test('a row hidden under the sticky header counts as not visible', () => {
    // row 3 starts at 130, scrollTop 110 -> 130 is under the header band [110, 144]
    expect(getScrollTarget({ ...base, index: 3, scrollTop: 110 })).toBe(3 * H)
  })

  test('targets are clamped to the scrollable range', () => {
    expect(getScrollTarget({ ...base, index: 0, scrollTop: 0 })).toBe(0)
    expect(getScrollTarget({ ...base, index: 999, scrollTop: 0 })).toBe(PAD + 1000 * H - 300)
  })

  test('an index past the end is treated as the last row', () => {
    // the last row is visible at the bottom, so nothing is scrolled
    expect(getScrollTarget({ ...base, index: 5000, scrollTop: 31800 })).toBeNull()
  })

  test('empty list has nothing to scroll to', () => {
    expect(getScrollTarget({ ...base, count: 0, index: 0, scrollTop: 0 })).toBeNull()
  })
})

describe('row slots', () => {
  const COUNT = 1000
  const OVERSCAN = 12

  /** the window a scroll position renders, as the hook computes it */
  function windowAt(scrollTop: number, viewportHeight: number, slots: number, count: number) {
    const visible = getRowRange({
      scrollTop,
      viewportHeight,
      rowHeight: H,
      overscan: 0,
      paddingStart: PAD,
      count: Infinity,
    })
    return { visible, win: getRowWindow(visible, slots, count) }
  }

  const rowsOf = (win: { start: number; end: number }) =>
    Array.from({ length: win.end - win.start }, (_, i) => win.start + i)

  test('slot count holds the visible rows plus overscan on both sides', () => {
    // 800 px = 25 rows, at most 26 overlap; plus 12 each side
    expect(getSlotCount({ viewportHeight: 800, rowHeight: H, overscan: OVERSCAN })).toBe(51)
    // 300 px = 9.4 rows, at most 11 overlap
    expect(getSlotCount({ viewportHeight: 300, rowHeight: H, overscan: 0 })).toBe(12)
  })

  for (const viewportHeight of [300, 500, 800, 1234]) {
    const slots = getSlotCount({ viewportHeight, rowHeight: H, overscan: OVERSCAN })

    test(`every scroll position (viewport ${viewportHeight}): full window, distinct slots, overscan kept`, () => {
      const last = PAD + COUNT * H - viewportHeight
      for (let scrollTop = 0; scrollTop <= last; scrollTop += 5) {
        const { visible, win } = windowAt(scrollTop, viewportHeight, slots, COUNT)
        expect(win.end - win.start).toBe(slots)
        expect(win.start).toBeGreaterThanOrEqual(0)
        expect(win.end).toBeLessThanOrEqual(COUNT)
        // the visible rows are drawn, with `OVERSCAN` rows around them unless the list ends there
        if (win.start > 0) expect(win.start).toBeLessThanOrEqual(visible.start - OVERSCAN)
        if (win.end < COUNT) expect(win.end).toBeGreaterThanOrEqual(visible.end + OVERSCAN)
        const used = new Set(rowsOf(win).map((i) => slotOf(i, slots)))
        expect(used.size).toBe(slots)
      }
    })

    test(`one row of scrolling moves exactly one row: it takes the slot the other one left (viewport ${viewportHeight})`, () => {
      const last = PAD + COUNT * H - viewportHeight
      let moves = 0
      for (let scrollTop = 0; scrollTop + H <= last; scrollTop += H) {
        const before = windowAt(scrollTop, viewportHeight, slots, COUNT).win
        const after = windowAt(scrollTop + H, viewportHeight, slots, COUNT).win
        // a step moves the window by one row, or not at all (top of the list under the header, bottom clamp)
        const moved = after.start - before.start
        expect(moved === 0 || moved === 1).toBe(true)
        if (moved === 0) {
          expect(after).toEqual(before)
          continue
        }
        moves += 1
        // the row at the start left and the row after the end entered, in the slot the leaving row had
        expect(after.end).toBe(before.end + 1)
        expect(slotOf(after.end - 1, slots)).toBe(slotOf(before.start, slots))
        // so the same row elements are in use, and no element is added or removed
        const slotsBefore = new Set(rowsOf(before).map((i) => slotOf(i, slots)))
        const slotsAfter = new Set(rowsOf(after).map((i) => slotOf(i, slots)))
        expect(slotsAfter).toEqual(slotsBefore)
      }
      expect(moves).toBeGreaterThan(COUNT / 2)
    })
  }

  test('fewer rows than slots: every row is drawn once, in its own slot', () => {
    const slots = getSlotCount({ viewportHeight: 800, rowHeight: H, overscan: OVERSCAN })
    for (const scrollTop of [0, 50, 200]) {
      const { win } = windowAt(scrollTop, 800, slots, 10)
      expect(win).toEqual({ start: 0, end: 10 })
      expect(rowsOf(win).map((i) => slotOf(i, slots))).toEqual(rowsOf(win))
    }
  })

  test('the window is clamped to the end of the list and keeps its size', () => {
    expect(getRowWindow({ start: 95, end: 100 }, 20, 100)).toEqual({ start: 80, end: 100 })
    expect(getRowWindow({ start: 0, end: 3 }, 20, 100)).toEqual({ start: 0, end: 20 })
  })

  test('an empty list has an empty window', () => {
    expect(getRowWindow({ start: 0, end: 5 }, 20, 0)).toEqual({ start: 0, end: 0 })
  })
})
