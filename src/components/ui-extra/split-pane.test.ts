import { describe, expect, test } from 'bun:test'
import { clamp, clampTopSize, topRange, topSizeFromKey, topSizeFromPointer } from './split-math'

const FREE = { min: 0, max: 100 }
const MIN15 = { min: 15, max: 100 }

describe('clamp', () => {
  test('keeps values inside the range and clamps the rest', () => {
    expect(clamp(50, 10, 90)).toBe(50)
    expect(clamp(5, 10, 90)).toBe(10)
    expect(clamp(95, 10, 90)).toBe(90)
  })

  test('returns max when min is above max', () => {
    expect(clamp(50, 80, 20)).toBe(20)
  })
})

describe('topRange', () => {
  test('free panes can take the whole container', () => {
    expect(topRange(FREE, FREE)).toEqual({ min: 0, max: 100 })
  })

  test('each pane keeps its own minimum (top min, bottom min caps the top max)', () => {
    expect(topRange(MIN15, MIN15)).toEqual({ min: 15, max: 85 })
  })

  test('a pane max limits the other pane from below', () => {
    expect(topRange({ min: 0, max: 60 }, { min: 0, max: 70 })).toEqual({ min: 30, max: 60 })
  })
})

describe('clampTopSize', () => {
  test('keeps a size that is already allowed (rounded to 3 decimals)', () => {
    expect(clampTopSize(45, MIN15, MIN15)).toBe(45)
    expect(clampTopSize(33.3333333, FREE, FREE)).toBe(33.333)
  })

  test('clamps below the top minimum and above the bottom minimum', () => {
    expect(clampTopSize(2, MIN15, MIN15)).toBe(15)
    expect(clampTopSize(99, MIN15, MIN15)).toBe(85)
  })

  test('falls back to the range max when the limits contradict each other', () => {
    expect(clampTopSize(50, { min: 90, max: 100 }, { min: 90, max: 100 })).toBe(10)
  })
})

describe('topSizeFromPointer', () => {
  test('converts a pointer position into a percent of the container', () => {
    expect(topSizeFromPointer(300, 100, 400, FREE, FREE)).toBe(50)
    expect(topSizeFromPointer(180, 100, 400, FREE, FREE)).toBe(20)
  })

  test('clamps pointers outside the container', () => {
    expect(topSizeFromPointer(50, 100, 400, MIN15, MIN15)).toBe(15)
    expect(topSizeFromPointer(900, 100, 400, MIN15, MIN15)).toBe(85)
  })

  test('returns null when the container has no height', () => {
    expect(topSizeFromPointer(300, 100, 0, FREE, FREE)).toBeNull()
    expect(topSizeFromPointer(300, 100, Number.NaN, FREE, FREE)).toBeNull()
  })
})

describe('topSizeFromKey', () => {
  test('ArrowUp shrinks the top pane and ArrowDown grows it, by 5 percent', () => {
    expect(topSizeFromKey('ArrowUp', 45, FREE, FREE)).toBe(40)
    expect(topSizeFromKey('ArrowDown', 45, FREE, FREE)).toBe(50)
  })

  test('steps stop at the limits', () => {
    expect(topSizeFromKey('ArrowUp', 17, MIN15, MIN15)).toBe(15)
    expect(topSizeFromKey('ArrowDown', 83, MIN15, MIN15)).toBe(85)
  })

  test('Home and End go to the smallest and largest allowed size', () => {
    expect(topSizeFromKey('Home', 45, MIN15, MIN15)).toBe(15)
    expect(topSizeFromKey('End', 45, MIN15, MIN15)).toBe(85)
    expect(topSizeFromKey('End', 45, FREE, FREE)).toBe(100)
  })

  test('returns null for keys it does not handle', () => {
    expect(topSizeFromKey('a', 45, FREE, FREE)).toBeNull()
    expect(topSizeFromKey('ArrowLeft', 45, FREE, FREE)).toBeNull()
    expect(topSizeFromKey('Enter', 45, FREE, FREE)).toBeNull()
  })
})
