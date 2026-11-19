import { useEffect, useState } from 'react'
import type { RefCallback } from 'react'

/**
 * Reports whether the element given to the returned ref intersects the viewport.
 * Starts as `true` so the first fetch is not delayed and server rendering works.
 */
export function useInView<T extends Element>(): [RefCallback<T>, boolean] {
  const [node, setNode] = useState<T | null>(null)
  const [inView, setInView] = useState(true)

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
