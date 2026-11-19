import type { AiAccess, TokenScope } from '@/lib/types'

export const SCOPES: { label: string; value: TokenScope }[] = [
  { label: 'Read only', value: 'read' },
  { label: 'Read and write', value: 'write' },
  { label: 'Admin', value: 'admin' },
]

export const SCOPE_HELP: Record<TokenScope, string> = {
  read: 'Can only run SELECT-like queries.',
  write: 'Can change data where the connection allows AI writes.',
  admin: 'Can also add and edit connections.',
}

export const SCOPE_BADGE: Record<TokenScope, { label: string; variant: 'success' | 'warning' | 'error' }> = {
  read: { label: 'Read only', variant: 'success' },
  write: { label: 'Read and write', variant: 'warning' },
  admin: { label: 'Admin', variant: 'error' },
}

export const AI_ACCESS_ITEMS: { label: string; value: AiAccess; help: string }[] = [
  { label: 'Off', value: 'off', help: 'AI tools cannot see this connection.' },
  { label: 'Read only', value: 'read', help: 'AI can run SELECT queries. This is the default.' },
  { label: 'Read and write', value: 'write', help: 'AI can change data when its token allows writes.' },
]
