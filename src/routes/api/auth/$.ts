import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/http/auth-api.server.ts.
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      ANY: async ({ request, params }) => {
        const { handleAuthRequest } = await import('@/server/http/auth-api.server')
        return handleAuthRequest(request, params._splat ?? '')
      },
    },
  },
})
