import { ClipboardCopyIcon, TriangleAlertIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import { copyWithToast } from '@/components/app/copy-feedback'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDuration } from '@/lib/format'
import { formatPlanNumber, parsePlan } from '@/lib/explain'
import type { ParsedPlan, PlanNode } from '@/lib/explain'
import { cn } from '@/lib/utils'

/** Reads a plan without throwing, so the caller can show the error in place of the plan. */
export function readPlan(raw: unknown, analyzed: boolean): { plan: ParsedPlan } | { error: string } {
  try {
    return { plan: parsePlan(raw, analyzed) }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** The estimate warning starts with this text, so its row can show the actual rows in warning color. */
const ESTIMATE_WARNING = 'Postgres expected'

/** Indent of a step: 12px of base padding plus 16px for each level. */
const BASE_INDENT = 12
const LEVEL_INDENT = 16

/** The metric columns, shared by the header and every step so they line up. */
const METRIC_COLUMNS =
  'grid grid-cols-[auto_auto_minmax(3rem,1fr)] items-center gap-3 max-sm:w-full sm:shrink-0 sm:grid-cols-[6.5rem_4.5rem_5rem]'

function NodeMetrics({ node, analyzed }: { node: PlanNode; analyzed: boolean }) {
  const estimateOff = node.warnings.some((w) => w.startsWith(ESTIMATE_WARNING))
  return (
    // h-5 on wide screens: the numbers sit on the title's line, not in the middle of a tall step
    <span className={cn(METRIC_COLUMNS, 'font-mono text-xs tabular-nums sm:h-5')}>
      {analyzed ? (
        <span
          className="truncate text-end text-muted-foreground"
          title={`${formatPlanNumber(node.actualRows ?? 0)} real rows, ${formatPlanNumber(node.estRows)} planned`}
        >
          <span className={cn(estimateOff && 'font-medium text-warning-foreground')}>
            {formatPlanNumber(node.actualRows ?? 0)}
          </span>
          {` / ${formatPlanNumber(node.estRows)}`}
        </span>
      ) : (
        <span className="truncate text-end text-muted-foreground">{formatPlanNumber(node.estRows)}</span>
      )}
      <span className="truncate text-end">
        {analyzed ? (node.selfMs === null ? '' : formatDuration(node.selfMs)) : formatPlanNumber(node.selfCost)}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/12">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${node.share * 100}%` }} />
      </span>
    </span>
  )
}

/** Labels above the metric columns, from sm up (on phones the metrics sit under each step). */
function MetricsHeader({ analyzed }: { analyzed: boolean }) {
  return (
    // the same scrollbar gutter as the list below, so the columns stay lined up
    <div className="flex items-center gap-3 overflow-hidden border-b bg-muted/40 py-1 ps-3 pe-3 text-muted-foreground text-xs [scrollbar-gutter:stable] max-sm:hidden">
      <span className="min-w-0 flex-1">Step</span>
      <span className={METRIC_COLUMNS}>
        <span className="text-end" title={analyzed ? 'Real rows / planned rows' : 'Planned rows'}>
          Rows
        </span>
        <span className="text-end">{analyzed ? 'Time' : 'Cost'}</span>
        <span>Share</span>
      </span>
    </div>
  )
}

function PlanRow({
  node,
  analyzed,
  slowest,
  open,
  onToggle,
}: {
  node: PlanNode
  analyzed: boolean
  slowest: boolean
  open: boolean
  onToggle: () => void
}) {
  const guides = Array.from({ length: node.depth }, (_, i) => i)
  const indent = `${BASE_INDENT + node.depth * LEVEL_INDENT}px`
  return (
    // The tree lines run through the whole step (warnings and details too) and 1px further, over the
    // border below, so they stay connected from one step to the next.
    <div className={cn('relative border-b last:border-b-0', node.neverExecuted && 'opacity-60')}>
      {guides.map((level) => (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 -bottom-px z-10 w-px bg-border"
          key={level}
          style={{ insetInlineStart: `${BASE_INDENT + level * LEVEL_INDENT + 4}px` }}
        />
      ))}
      <Button
        aria-expanded={open}
        className="h-auto w-full flex-col items-stretch gap-1 rounded-none border-0 py-2 sm:h-auto pe-3 text-start font-normal sm:flex-row sm:items-start sm:gap-3"
        onClick={onToggle}
        style={{ paddingInlineStart: indent }}
        variant="ghost"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-medium text-sm" title={node.title}>
              {node.title}
            </span>
            {slowest && (
              <Badge className="shrink-0" size="sm" variant="warning">
                Slowest step
              </Badge>
            )}
            {node.neverExecuted && (
              <Badge className="shrink-0" size="sm" variant="outline">
                Never ran
              </Badge>
            )}
          </span>
          {node.detail.map((line, i) => (
            <span className="block truncate font-mono text-muted-foreground text-xs leading-4" key={i} title={line}>
              {line}
            </span>
          ))}
        </span>
        <NodeMetrics analyzed={analyzed} node={node} />
      </Button>
      {node.warnings.map((warning, i) => (
        <p
          className="-mt-1 flex items-start gap-1.5 pe-3 pb-2 text-warning-foreground text-xs leading-4"
          key={i}
          style={{ paddingInlineStart: indent }}
        >
          <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 translate-y-px text-warning" />
          <span className="min-w-0">{warning}</span>
        </p>
      ))}
      {open && (
        <div
          className="mb-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 py-2 pe-3 font-mono text-xs"
          style={{ paddingInlineStart: indent }}
        >
          {Object.entries(node.raw).map(([key, value]) => (
            <Fragment key={key}>
              <span className="text-muted-foreground">{key}</span>
              <span className="min-w-0 break-all">
                {typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

export function PlanView({ plan, raw }: { plan: ParsedPlan; raw: unknown }) {
  // a new plan starts with every step collapsed
  const [shown, setShown] = useState(plan)
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  if (plan !== shown) {
    setShown(plan)
    setOpen(new Set())
  }

  const toggle = (id: number) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
        {plan.analyzed ? (
          <>
            <span className="tabular-nums">
              Planning {formatDuration(plan.planningMs ?? 0)} · Execution {formatDuration(plan.executionMs ?? 0)}
            </span>
            <span className="text-muted-foreground">Measured by running the query. Changes were rolled back.</span>
          </>
        ) : (
          <>
            <span className="tabular-nums">Estimated cost {formatPlanNumber(plan.totalCost)}</span>
            <span className="text-muted-foreground">Estimate only. The query did not run.</span>
          </>
        )}
        <span className="ms-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Copy plan as JSON"
                  onClick={() => void copyWithToast(JSON.stringify(raw, null, 2), 'Plan copied')}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <ClipboardCopyIcon />
            </TooltipTrigger>
            <TooltipPopup>Copy plan as JSON</TooltipPopup>
          </Tooltip>
        </span>
      </div>

      <MetricsHeader analyzed={plan.analyzed} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {plan.nodes.map((node) => (
          <PlanRow
            analyzed={plan.analyzed}
            key={node.id}
            node={node}
            onToggle={() => toggle(node.id)}
            open={open.has(node.id)}
            slowest={node.id === plan.slowestId}
          />
        ))}
      </div>
    </div>
  )
}
