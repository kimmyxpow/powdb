import { afterEach, describe, expect, test } from 'bun:test'
import { useProductionGuardStore } from './production-guard'

const store = useProductionGuardStore

const orders = {
  action: 'Save changes to 2 rows in public.orders',
  connectionName: 'prod',
  database: 'app',
  sql: 'BEGIN;',
}
const refunds = { action: 'Delete 1 row in public.refunds', connectionName: 'prod', database: 'app', destructive: true }

afterEach(() => {
  // a test that leaves a prompt waiting must not leak it into the next one
  store.getState().settle(false)
})

describe('useProductionGuardStore', () => {
  test('starts with nothing pending', () => {
    expect(store.getState().pending).toBeNull()
  })

  test('a request shows its prompt and waits until it is answered', () => {
    const answer = store.getState().requestConfirm(orders)
    expect(store.getState().pending?.prompt).toEqual(orders)
    expect(Bun.peek(answer)).toBe(answer)
  })

  test('confirm resolves the request true and clears the prompt', async () => {
    const answer = store.getState().requestConfirm(orders)
    store.getState().settle(true)
    expect(await answer).toBe(true)
    expect(store.getState().pending).toBeNull()
  })

  test('cancel resolves the request false and clears the prompt', async () => {
    const answer = store.getState().requestConfirm(orders)
    store.getState().settle(false)
    expect(await answer).toBe(false)
    expect(store.getState().pending).toBeNull()
  })

  test('a second request replaces the waiting one, which resolves false', async () => {
    const first = store.getState().requestConfirm(orders)
    const second = store.getState().requestConfirm(refunds)
    expect(await first).toBe(false)
    expect(store.getState().pending?.prompt).toEqual(refunds)
    expect(Bun.peek(second)).toBe(second)
  })

  test('after a replacement, the answer goes to the newest request only', async () => {
    const first = store.getState().requestConfirm(orders)
    const second = store.getState().requestConfirm(refunds)
    store.getState().settle(true)
    expect(await second).toBe(true)
    expect(await first).toBe(false)
    expect(store.getState().pending).toBeNull()
  })

  test('a settle with nothing pending does nothing', () => {
    store.getState().settle(true)
    store.getState().settle(false)
    expect(store.getState().pending).toBeNull()
  })

  test('only the first answer counts: a settle after the request is answered is ignored', async () => {
    const answer = store.getState().requestConfirm(orders)
    store.getState().settle(true)
    store.getState().settle(false)
    expect(await answer).toBe(true)
  })
})
