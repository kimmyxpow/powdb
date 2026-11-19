import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/restore.server.ts.
export const Route = createFileRoute('/api/import/restore')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleRestore } = await import('@/server/restore.server')
        return handleRestore(request)
      },
    },
  },
})
