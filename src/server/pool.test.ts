import { describe, expect, test } from 'bun:test'
import { connectedIds } from './pool.server'

describe('connectedIds', () => {
  test('is empty when no connection has been opened', () => {
    expect(connectedIds()).toEqual([])
  })
})
