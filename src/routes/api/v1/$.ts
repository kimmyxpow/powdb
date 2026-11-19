import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/http/v1-api.server.ts.
export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      ANY: async ({ request, params }) => {
        const { handleV1Request } = await import('@/server/http/v1-api.server')
        return handleV1Request(request, params._splat ?? '')
      },
    },
  },
})
