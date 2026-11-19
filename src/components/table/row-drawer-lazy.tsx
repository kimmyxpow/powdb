import { lazy, Suspense } from 'react'
import type { ComponentProps } from 'react'
import type { RowDrawer } from './row-drawer'

// The drawer's code is only needed once a row is opened, so it is split into its own chunk.
// The import lives at module level: the React Compiler cannot compile import() inside a component.
const RowDrawerImpl = lazy(() => import('./row-drawer').then((m) => ({ default: m.RowDrawer })))

let preloading: Promise<unknown> | undefined

/** Fetches the drawer's code ahead of the first open. Safe to call more than once. */
export function preloadRowDrawer() {
  if (!preloading) preloading = import('./row-drawer')
  return preloading
}

export function LazyRowDrawer(props: ComponentProps<typeof RowDrawer>) {
  return (
    <Suspense fallback={null}>
      <RowDrawerImpl {...props} />
    </Suspense>
  )
}
