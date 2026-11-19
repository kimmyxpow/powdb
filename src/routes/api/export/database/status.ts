import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/dump.server.ts.
export const Route = createFileRoute('/api/export/database/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleDatabaseExportStatus } = await import('@/server/dump.server')
        return handleDatabaseExportStatus(request)
      },
    },
  },
})
