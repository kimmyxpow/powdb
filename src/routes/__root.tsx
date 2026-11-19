import { HeadContent, Scripts, createRootRouteWithContext, Link, redirect } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { DatabaseZapIcon } from 'lucide-react'
import { AiAccessDialog } from '@/components/app/ai-access-dialog'
import { authStateQuery } from '@/lib/queries'
import { AnchoredToastProvider, ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useEffect } from 'react'
import { themeScript } from '@/lib/theme'
import appCss from '../styles.css?url'
import interWoff2 from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'

interface RouterContext {
  queryClient: QueryClient
}

const favicon = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#262626"/><ellipse cx="16" cy="10" rx="8" ry="3.2" fill="none" stroke="#fafafa" stroke-width="2"/><path d="M8 10v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V10M8 16c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" fill="none" stroke="#fafafa" stroke-width="2"/></svg>`,
)}`

export const Route = createRootRouteWithContext<RouterContext>()({
  // Runs in the browser on every navigation (SSR is off): first start goes to /setup,
  // signed-out visitors go to /login, and signed-in visitors skip the sign-in pages.
  beforeLoad: async ({ context, location }) => {
    const state = await context.queryClient.fetchQuery(authStateQuery())
    const path = location.pathname
    if (state.setupRequired) {
      if (path !== '/setup') throw redirect({ to: '/setup' })
      return
    }
    if (path === '/setup') throw redirect({ to: state.authenticated ? '/' : '/login' })
    if (state.authEnabled && !state.authenticated) {
      if (path !== '/login') throw redirect({ to: '/login', search: { redirect: location.href } })
      return
    }
    if (state.authenticated && path === '/login') throw redirect({ to: '/' })
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'pow/view' },
      { name: 'description', content: 'A simple, modern PostgreSQL explorer' },
    ],
    links: [
      // Fetch the UI font together with the HTML so text never reflows when it swaps in.
      // (Dev serves fonts lazily from node_modules, where a preload only produces warnings.)
      ...(import.meta.env.PROD
        ? [{ rel: 'preload', href: interWoff2, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' as const }]
        : []),
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: favicon },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { data: auth } = useQuery(authStateQuery())
  const aiAvailable = Boolean(auth && (auth.authenticated || !auth.authEnabled))

  useEffect(() => {
    // Warm up the monospace font (grid cells, SQL editor) before the first table renders.
    // Not a <link rel=preload>: that warns on pages that show no monospace text.
    document.fonts.load('1em "Geist Mono Variable"').catch(() => {})
  }, [])

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body className="relative">
        <TooltipProvider delay={400}>
          <ToastProvider position="bottom-right">
            <AnchoredToastProvider>
              <div className="isolate relative flex h-svh flex-col">
                {children}
                {aiAvailable && <AiAccessDialog />}
              </div>
            </AnchoredToastProvider>
          </ToastProvider>
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  )
}

function NotFound() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DatabaseZapIcon />
        </EmptyMedia>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>The page you are looking for does not exist.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button render={<Link to="/" />} variant="outline">
          Back to connections
        </Button>
      </EmptyContent>
    </Empty>
  )
}
