import { afterEach, describe, expect, test } from 'bun:test'
import { copyText } from './export'

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

function restore(name: 'navigator' | 'document', desc: PropertyDescriptor | undefined) {
  if (desc) Object.defineProperty(globalThis, name, desc)
  else Reflect.deleteProperty(globalThis, name)
}

afterEach(() => {
  restore('navigator', realNavigator)
  restore('document', realDocument)
})

/** A textarea stub that records whether it was removed again. */
function fakeDocument(execCommand: () => boolean) {
  const textarea = { value: '', style: {}, select: () => {}, remove: () => {}, removed: false }
  textarea.remove = () => {
    textarea.removed = true
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => textarea, body: { appendChild: () => textarea }, execCommand },
  })
  return textarea
}

function fakeClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } })
}

describe('copyText', () => {
  test('resolves true when the clipboard accepts the text', async () => {
    fakeClipboard(() => Promise.resolve())
    expect(await copyText('hello')).toBe(true)
  })

  test('falls back to execCommand and reports its result', async () => {
    fakeClipboard(() => Promise.reject(new Error('blocked')))
    const textarea = fakeDocument(() => true)
    expect(await copyText('hello')).toBe(true)
    expect(textarea.removed).toBe(true)
  })

  test('resolves false when execCommand reports failure', async () => {
    fakeClipboard(() => Promise.reject(new Error('blocked')))
    const textarea = fakeDocument(() => false)
    expect(await copyText('hello')).toBe(false)
    expect(textarea.removed).toBe(true)
  })

  test('resolves false when execCommand throws, and still removes the textarea', async () => {
    fakeClipboard(() => Promise.reject(new Error('blocked')))
    const textarea = fakeDocument(() => {
      throw new Error('unsupported')
    })
    expect(await copyText('hello')).toBe(false)
    expect(textarea.removed).toBe(true)
  })
})
