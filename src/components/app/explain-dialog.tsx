import { useQuery } from '@tanstack/react-query'
import { SquareTerminalIcon } from 'lucide-react'
import { explainSqlFn } from '@/api/explorer.functions'
import { SqlCodeView } from '@/components/sql/codemirror'
import { PlanUnavailable, PlanView, readPlan } from '@/components/sql/plan-view'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { isExplainable } from '@/lib/explain'
import { countLabel, formatDuration } from '@/lib/format'
import { keys } from '@/lib/queries'

/** One statement from the Health section, with the numbers the slow queries table shows. */
export interface QueryRow {
  query: string
  calls: number
  meanMs: number
  totalMs: number
}

interface QueryDialogProps {
  connectionId: string
  database: string
  /** The statement to show. The parent keeps it set while the dialog closes. */
  row: QueryRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenInEditor: (sql: string) => void
}

/**
 * The query of one statement from the Health section, with its plan under it. Only a plain EXPLAIN runs
 * here, never Explain Analyze, because that would run the query. A statement that EXPLAIN cannot take
 * gets no plan request at all.
 */
export function QueryDialog({ connectionId, database, row, open, onOpenChange, onOpenInEditor }: QueryDialogProps) {
  const { query } = row
  const explainable = isExplainable(query)
  const explain = useQuery({
    queryKey: [...keys.db(connectionId, database), 'explain', query],
    queryFn: () =>
      explainSqlFn({ data: { connectionId, database, sql: query, analyze: false, executionId: crypto.randomUUID() } }),
    enabled: open && explainable,
    staleTime: 30_000,
    // a failed request is shown at once, not after three automatic retries
    retry: false,
  })

  const result = explain.data
  const read = result && !result.error && !result.unavailable ? readPlan(result.plan, false) : null
  const plan = read && 'plan' in read ? read.plan : null
  const failure = explain.error?.message ?? result?.error?.message ?? (read && 'error' in read ? read.error : null)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Query</DialogTitle>
          <DialogDescription>
            {`${countLabel(row.calls, 'call')} · avg ${formatDuration(row.meanMs)} · total ${formatDuration(row.totalMs)}`}
          </DialogDescription>
        </DialogHeader>

        {/* a fixed height, so the dialog keeps its size while loading, on errors and with a plan */}
        <div className="flex h-[min(60vh,32rem)] min-h-0 flex-col border-t">
          {/* the query scrolls inside itself when it is long, so the plan keeps room below it */}
          <div className="shrink-0 border-b">
            <SqlCodeView maxHeight="10rem" value={query} />
          </div>

          {!explainable ? (
            <PlanUnavailable context="dialog" reason="not-explainable" />
          ) : explain.isPending ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner aria-label="Loading plan" className="size-5 text-muted-foreground" />
            </div>
          ) : failure ? (
            // padding on a wrapper, not a margin on the alert: the alert is full width and would overflow
            <div className="p-3">
              <Alert variant="error">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            </div>
          ) : result?.unavailable ? (
            <PlanUnavailable context="dialog" reason={result.unavailable} />
          ) : plan && result ? (
            <PlanView
              generic={result.generic}
              onOpenSql={(suggested) => {
                onOpenChange(false)
                onOpenInEditor(suggested)
              }}
              plan={plan}
              raw={result.plan}
            />
          ) : null}
        </div>

        <DialogFooter>
          <Button
            onClick={() => {
              onOpenChange(false)
              onOpenInEditor(query)
            }}
            variant="outline"
          >
            <SquareTerminalIcon aria-hidden="true" />
            Open in SQL editor
          </Button>
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
