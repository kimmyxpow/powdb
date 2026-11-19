// Pure size math for SplitPane. Sizes are percentages of the container height. The top pane
// size is the only value that changes; the bottom pane always takes the rest (100 - top).

export interface PaneLimits {
  /** smallest allowed size, in percent */
  min: number
  /** largest allowed size, in percent */
  max: number
}

/** how far one arrow key press moves the separator, in percent */
const KEYBOARD_STEP = 5

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Clamp to [min, max]. When min > max the result is max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** The sizes the top pane may take so that both panes stay inside their own limits. */
export function topRange(top: PaneLimits, bottom: PaneLimits): { min: number; max: number } {
  return {
    min: Math.max(top.min, 100 - bottom.max),
    max: Math.min(top.max, 100 - bottom.min),
  }
}

/** Clamp a top pane size into the allowed range. If the two limits cannot both hold, the range max wins. */
export function clampTopSize(size: number, top: PaneLimits, bottom: PaneLimits): number {
  const range = topRange(top, bottom)
  return round(clamp(size, range.min, range.max))
}

/**
 * Top pane size for a pointer at `pointerY`, given the container's top edge and height.
 * Returns null when the container has no height yet (nothing to measure against).
 */
export function topSizeFromPointer(
  pointerY: number,
  containerTop: number,
  containerHeight: number,
  top: PaneLimits,
  bottom: PaneLimits,
): number | null {
  if (!(containerHeight > 0)) return null
  return clampTopSize(((pointerY - containerTop) / containerHeight) * 100, top, bottom)
}

/**
 * New top pane size for a key pressed on the separator, or null when the key is not one we handle.
 * ArrowUp/ArrowDown move by KEYBOARD_STEP, Home/End jump to the smallest/largest allowed size.
 */
export function topSizeFromKey(key: string, size: number, top: PaneLimits, bottom: PaneLimits): number | null {
  switch (key) {
    case 'ArrowUp':
      return clampTopSize(size - KEYBOARD_STEP, top, bottom)
    case 'ArrowDown':
      return clampTopSize(size + KEYBOARD_STEP, top, bottom)
    case 'Home':
      return clampTopSize(Number.NEGATIVE_INFINITY, top, bottom)
    case 'End':
      return clampTopSize(Number.POSITIVE_INFINITY, top, bottom)
    default:
      return null
  }
}
