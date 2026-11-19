import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/dump.server.ts.
export const Route = createFileRoute('/api/export/database')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleDatabaseExport } = await import('@/server/dump.server')
        return handleDatabaseExport(request)
      },
    },
  },
})
