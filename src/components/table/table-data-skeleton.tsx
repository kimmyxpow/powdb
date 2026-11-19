import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// The Data view while its rows and metadata load. Every box has the size of the real one
// it stands for: toolbar and footer from table-data.tsx, header and rows from grid/data-grid.tsx
// (HEADER_H 34, ROW_H 32, the row-number gutter passed in, open-row column 28). Only the bars
// inside the cells are placeholders.
// enough rows to fill a tall screen; the grid area clips the rest
const ROWS = 40
const COLUMN_WIDTHS = ['w-3/5', 'w-2/5', 'w-1/2', 'w-4/5']

export function TableDataSkeleton({ gutter }: { gutter: number }) {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">Loading rows</span>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Skeleton className="h-8 w-full rounded-lg sm:h-7 sm:w-60" />
        <Skeleton className="h-8 w-20 rounded-lg sm:h-7" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" />
        <div className="flex items-center gap-1">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton className="size-8 rounded-lg sm:size-7" key={i} />
          ))}
          <Skeleton className="h-8 w-24 rounded-lg sm:h-7" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-8.5 shrink-0 border-b bg-grid-header font-sans">
            <div className="flex shrink-0 items-center justify-center border-r" style={{ width: gutter }} />
            <div className="w-7 shrink-0 border-r" />
            {COLUMN_WIDTHS.map((_, i) => (
              <div className="flex w-40 shrink-0 items-center gap-1.5 border-r px-2.5" key={i}>
                <Skeleton className="h-2.5 w-20" />
              </div>
            ))}
            <div className="flex-1" />
          </div>

          {Array.from({ length: ROWS }, (_, r) => (
            <div className="flex h-8 w-full shrink-0 border-b border-border/70 bg-background" key={r}>
              <div
                className="flex shrink-0 items-center justify-center border-r border-border/70"
                style={{ width: gutter }}
              >
                <Skeleton className="h-2.5 w-4" />
              </div>
              <div className="w-7 shrink-0 border-r border-border/70" />
              {COLUMN_WIDTHS.map((width, c) => (
                <div className="flex w-40 shrink-0 items-center border-r border-border/70 px-2.5" key={c}>
                  <Skeleton className={cn('h-3', width)} />
                </div>
              ))}
              <div className="flex-1" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5 text-muted-foreground text-xs">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-20 rounded-lg sm:h-7" />
          <Skeleton className="h-3 w-12 max-sm:hidden" />
        </div>
        <div className="flex items-center gap-1">
          <Skeleton className="me-2 h-3 w-24" />
          <Skeleton className="size-7 rounded-md sm:size-6" />
          <Skeleton className="size-7 rounded-md sm:size-6" />
          <Skeleton className="h-3 w-10 mx-1" />
          <Skeleton className="size-7 rounded-md sm:size-6" />
        </div>
      </div>
    </div>
  )
}
