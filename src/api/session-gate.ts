export interface SessionGate {
  /** the function is listed in public-functions.ts */
  isPublic: boolean
  authEnabled: boolean
  sessionValid: boolean
}

/** True when the call must be refused: the function is private, auth is on, and there is no valid session. */
export function needsSignIn({ isPublic, authEnabled, sessionValid }: SessionGate): boolean {
  return !isPublic && authEnabled && !sessionValid
}
