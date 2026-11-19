import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/export.server.ts.
export const Route = createFileRoute('/api/export/table')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleExportRequest } = await import('@/server/export.server')
        return handleExportRequest(request)
      },
    },
  },
})
