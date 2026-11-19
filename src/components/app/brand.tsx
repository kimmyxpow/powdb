import { cn } from '@/lib/utils'
import type { ConnectionColor } from '@/lib/types'

export const colorClasses: Record<ConnectionColor, { dot: string; soft: string; ring: string }> = {
  neutral: {
    dot: 'bg-neutral-500',
    soft: 'bg-neutral-500/12 text-neutral-700 dark:text-neutral-300',
    ring: 'ring-neutral-500',
  },
  blue: { dot: 'bg-blue-500', soft: 'bg-blue-500/12 text-blue-700 dark:text-blue-300', ring: 'ring-blue-500' },
  emerald: {
    dot: 'bg-emerald-500',
    soft: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    ring: 'ring-emerald-500',
  },
  amber: { dot: 'bg-amber-500', soft: 'bg-amber-500/14 text-amber-700 dark:text-amber-300', ring: 'ring-amber-500' },
  rose: { dot: 'bg-rose-500', soft: 'bg-rose-500/12 text-rose-700 dark:text-rose-300', ring: 'ring-rose-500' },
  violet: {
    dot: 'bg-violet-500',
    soft: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
    ring: 'ring-violet-500',
  },
  cyan: { dot: 'bg-cyan-500', soft: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300', ring: 'ring-cyan-500' },
  orange: {
    dot: 'bg-orange-500',
    soft: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
    ring: 'ring-orange-500',
  },
}

export function ConnectionAvatar({
  name,
  color,
  className,
}: {
  name: string
  color: ConnectionColor
  className?: string
}) {
  const initials =
    name
      .split(/[\s_\-.@/]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg font-semibold text-xs',
        colorClasses[color].soft,
        className,
      )}
    >
      {initials}
    </span>
  )
}

/** The wordmark. The icon is only used as the favicon. */
export function Logo() {
  return <span className="font-semibold text-base tracking-tight">pow/view</span>
}
