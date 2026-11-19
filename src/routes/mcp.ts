import { createFileRoute } from '@tanstack/react-router'

// Thin route: the logic lives in src/server/http/mcp.server.ts.
export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { handleMcpRequest } = await import('@/server/http/mcp.server')
        return handleMcpRequest(request)
      },
    },
  },
})
