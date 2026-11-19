// Public entry for the SQL editors. The CodeMirror code lives in ./codemirror-core and is
// loaded on first render through React.lazy, so the editor packages are not part of the
// entry or route chunks. The fallbacks keep the same box size, so nothing jumps when it loads.
import type { SQLNamespace } from '@codemirror/lang-sql'
import { forwardRef, lazy, Suspense } from 'react'
import type { StatementRange } from '@/lib/sql'
import { cn } from '@/lib/utils'

export interface SqlEditorHandle {
  /** selected text, or the whole document */
  getRunText: () => { text: string; offset: number; isSelection: boolean }
  getStatementAtCursor: () => StatementRange | null
  setValue: (value: string) => void
  focus: () => void
  showError: (range: { from: number; to: number } | null) => void
}

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  schema?: SQLNamespace
  defaultSchema?: string
  onRun: () => void
  onRunStatement: () => void
  onFormat: () => void
  autoFocus?: boolean
}

export interface SqlCodeViewProps {
  value: string
  className?: string
  maxHeight?: string
}

const LazySqlEditor = lazy(() => import('./codemirror-core').then((m) => ({ default: m.SqlEditorCore })))
const LazySqlCodeView = lazy(() => import('./codemirror-core').then((m) => ({ default: m.SqlCodeViewCore })))

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(props, ref) {
  return (
    <Suspense fallback={<div aria-hidden className="h-full min-h-0" />}>
      <LazySqlEditor {...props} ref={ref} />
    </Suspense>
  )
})

// --- read-only viewer ------------------------------------------------------

const viewerFont = {
  fontFamily: 'var(--font-mono)',
  fontSize: '13px',
  lineHeight: '1.6',
} as const

/** Plain text stand-in for the read-only viewer while its code loads: same box, same text. */
function SqlCodeViewFallback({ value, className, maxHeight }: SqlCodeViewProps) {
  const count = value.split('\n').length
  const numbers = Array.from({ length: count }, (_, i) => i + 1).join('\n')
  return (
    <div className={cn('min-h-0 overflow-auto', className)} style={{ maxHeight }}>
      <div className="flex py-[10px]" style={viewerFont}>
        <pre
          aria-hidden
          className="m-0 min-w-[44px] shrink-0 pl-[6px] pr-[10px] text-right font-[inherit]"
          style={{ color: 'color-mix(in srgb, var(--muted-foreground) 55%, transparent)' }}
        >
          {numbers}
        </pre>
        <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words pl-[6px] pr-[2px] font-[inherit] text-foreground">
          {value}
        </pre>
      </div>
    </div>
  )
}

export function SqlCodeView(props: SqlCodeViewProps) {
  return (
    <Suspense fallback={<SqlCodeViewFallback {...props} />}>
      <LazySqlCodeView {...props} />
    </Suspense>
  )
}
