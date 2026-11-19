import { describe, expect, test } from 'bun:test'
import { canManageConnections, canManageTokens, effectiveAccess, type Principal } from './access.server'

const user: Principal = { kind: 'user', label: 'admin' }

function agent(scope: 'read' | 'write' | 'admin', connections: 'all' | string[] = 'all'): Principal {
  return { kind: 'agent', label: 'bot', scope, connections, tokenId: 'abcd1234' }
}

function conn(overrides: { readOnly?: boolean; aiAccess?: 'off' | 'read' | 'write'; id?: string }) {
  return { id: overrides.id ?? 'c1', readOnly: overrides.readOnly ?? false, aiAccess: overrides.aiAccess ?? 'write' }
}

describe('effectiveAccess for users', () => {
  test('follows only the connection readOnly flag', () => {
    expect(effectiveAccess(user, conn({ readOnly: false }))).toBe('write')
    expect(effectiveAccess(user, conn({ readOnly: true }))).toBe('read')
  })

  test('ignores aiAccess, including off', () => {
    expect(effectiveAccess(user, conn({ aiAccess: 'off' }))).toBe('write')
    expect(effectiveAccess(user, conn({ aiAccess: 'read' }))).toBe('write')
    expect(effectiveAccess(user, conn({ aiAccess: 'off', readOnly: true }))).toBe('read')
  })
})

describe('effectiveAccess for agents', () => {
  test('aiAccess off means no access, whatever the scope', () => {
    for (const scope of ['read', 'write', 'admin'] as const) {
      expect(effectiveAccess(agent(scope), conn({ aiAccess: 'off' }))).toBe('none')
    }
  })

  test('aiAccess read caps everything at read', () => {
    expect(effectiveAccess(agent('read'), conn({ aiAccess: 'read' }))).toBe('read')
    expect(effectiveAccess(agent('write'), conn({ aiAccess: 'read' }))).toBe('read')
    expect(effectiveAccess(agent('admin'), conn({ aiAccess: 'read' }))).toBe('read')
  })

  test('read scope is read-only even when aiAccess is write', () => {
    expect(effectiveAccess(agent('read'), conn({ aiAccess: 'write' }))).toBe('read')
  })

  test('write and admin scope write when aiAccess is write and the connection is writable', () => {
    expect(effectiveAccess(agent('write'), conn({ aiAccess: 'write' }))).toBe('write')
    expect(effectiveAccess(agent('admin'), conn({ aiAccess: 'write' }))).toBe('write')
  })

  test('the connection readOnly flag caps agents at read', () => {
    expect(effectiveAccess(agent('write'), conn({ aiAccess: 'write', readOnly: true }))).toBe('read')
    expect(effectiveAccess(agent('admin'), conn({ aiAccess: 'write', readOnly: true }))).toBe('read')
  })

  test('a token limited to other connections has no access', () => {
    const limited = agent('admin', ['c2'])
    expect(effectiveAccess(limited, conn({ id: 'c1' }))).toBe('none')
    expect(effectiveAccess(agent('write', ['c1', 'c2']), conn({ id: 'c1' }))).toBe('write')
    expect(effectiveAccess(agent('write', ['c2', 'c3']), conn({ id: 'c1' }))).toBe('none')
  })

  test('a token limited to a connection still obeys that connection aiAccess', () => {
    expect(effectiveAccess(agent('write', ['c1']), conn({ id: 'c1', aiAccess: 'read' }))).toBe('read')
  })
})

describe('management rights', () => {
  test('connections: users and admin-scope agents', () => {
    expect(canManageConnections(user)).toBe(true)
    expect(canManageConnections(agent('admin'))).toBe(true)
    expect(canManageConnections(agent('write'))).toBe(false)
    expect(canManageConnections(agent('read'))).toBe(false)
  })

  test('tokens and audit: users only', () => {
    expect(canManageTokens(user)).toBe(true)
    expect(canManageTokens(agent('admin'))).toBe(false)
  })
})
