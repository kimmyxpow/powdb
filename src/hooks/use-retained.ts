import { useState } from 'react'

/**
 * Keeps showing the last non-null value after it becomes null/undefined.
 *
 * Overlays (dialogs, drawers, popovers) animate out after `open` turns false.
 * If their content is derived from the same state that closes them, the content
 * would vanish first and the overlay would collapse mid-animation. Rendering the
 * retained value instead keeps the content stable until the overlay is gone.
 */
export function useRetained<T>(value: T | null | undefined): T | null | undefined {
  const [retained, setRetained] = useState(value)
  if (value !== null && value !== undefined && value !== retained) setRetained(() => value)
  return value ?? retained
}
