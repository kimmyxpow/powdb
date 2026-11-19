import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/import-csv.server.ts.
export const Route = createFileRoute('/api/import/csv')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleCsvImport } = await import('@/server/import-csv.server')
        return handleCsvImport(request)
      },
    },
  },
})
