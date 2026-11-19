import { describe, expect, test } from 'bun:test'
import { needsSignIn } from './session-gate'

describe('needsSignIn', () => {
  // [isPublic, authEnabled, sessionValid, refused]
  test.each([
    [true, true, true, false],
    [true, true, false, false],
    [true, false, true, false],
    [true, false, false, false],
    [false, false, true, false],
    [false, false, false, false],
    [false, true, true, false],
    [false, true, false, true],
  ])('isPublic=%p authEnabled=%p sessionValid=%p refused=%p', (isPublic, authEnabled, sessionValid, refused) => {
    expect(needsSignIn({ isPublic, authEnabled, sessionValid })).toBe(refused)
  })
})
