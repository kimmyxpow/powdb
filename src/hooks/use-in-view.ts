import { useEffect, useState } from 'react'
import type { RefCallback } from 'react'

/**
 * Reports whether the element given to the returned ref intersects the viewport.
 * Starts as `initial` (true by default) so the first fetch is not delayed and server rendering works.
 * Pass false to wait until the element is seen in the viewport.
 */
export function useInView<T extends Element>(initial = true): [RefCallback<T>, boolean] {
  const [node, setNode] = useState<T | null>(null)
  const [inView, setInView] = useState(initial)

  useEffect(() => {
    if (!node) return
    // state, not a ref, so the effect re-runs when the element mounts or changes
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: '0px',
      threshold: 0,
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return [setNode, inView]
}
