// Expiry choices for API tokens, shared by the UI. The CLI keeps its own copy of the parsing.

const DAY_MS = 86_400_000

/** Select values: a number of days, or "never". */
export const EXPIRY_OPTIONS: { label: string; value: string }[] = [
  { label: 'In 30 days', value: '30' },
  { label: 'In 90 days', value: '90' },
  { label: 'In 1 year', value: '365' },
  { label: 'Never', value: 'never' },
]

export const DEFAULT_EXPIRY = '90'

/** The days a select value stands for; null means the token never expires. */
export function expiryDays(value: string): number | null {
  return value === 'never' ? null : Number(value)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "in 23 days", "in 11 months", "in 2 years", "never", or expired. */
export function expiryStatus(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): { expired: boolean; text: string } {
  if (!expiresAt) return { expired: false, text: 'never' }
  const left = Date.parse(expiresAt) - now
  if (left <= 0) return { expired: true, text: 'expired' }
  const days = Math.floor(left / DAY_MS)
  if (days < 1) return { expired: false, text: 'in less than a day' }
  if (days < 60) return { expired: false, text: `in ${plural(days, 'day')}` }
  const months = Math.round(days / 30)
  if (months < 24) return { expired: false, text: `in ${plural(months, 'month')}` }
  return { expired: false, text: `in ${plural(Math.round(months / 12), 'year')}` }
}
