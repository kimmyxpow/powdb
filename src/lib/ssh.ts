// SSH tunnel helpers shared by the connection dialog and the server.
/** A private key must contain this text (PEM "-----BEGIN RSA PRIVATE KEY-----", OpenSSH, ...). */
const SSH_KEY_MARKER = 'PRIVATE KEY'

export const SSH_KEY_MESSAGE =
  'That does not look like a private key. Paste the whole key, including the BEGIN and END lines.'

/** Ready to use as a fingerprint label: "SHA256:..." shortened in the middle for display. */
export function shortenMiddle(text: string, keep = 10): string {
  if (text.length <= keep * 2 + 1) return text
  return `${text.slice(0, keep)}…${text.slice(-keep)}`
}

/** True when the text is what a private key looks like (used before saving). */
export function looksLikePrivateKey(text: string): boolean {
  return text.includes(SSH_KEY_MARKER)
}
