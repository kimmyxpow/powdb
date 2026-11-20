import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { auditQuery } from '@/lib/activity-queries'
import { timeAgo } from '@/lib/format'
import type { AuditEntry } from '@/lib/types'

const ACTIVITY_LIMIT = 20

export function Box({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border">{children}</div>
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-muted-foreground text-sm">{children}</div>
}

/** Recent queries from AI tools. The SQL column takes the leftover width; long SQL is cut off with a tooltip. */
export function ActivitySection() {
  const { data: entries, isPending, error } = useQuery({ ...auditQuery(ACTIVITY_LIMIT), staleTime: 0 })

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      {error ? (
        <Box>
          <EmptyLine>{error.message}</EmptyLine>
        </Box>
      ) : isPending ? (
        <Box>
          <EmptyLine>Loading activity…</EmptyLine>
        </Box>
      ) : entries.length === 0 ? (
        <Empty className="rounded-xl border">
          <EmptyDescription>No queries from AI tools yet.</EmptyDescription>
        </Empty>
      ) : (
        <Box>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>SQL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry, i) => (
                <ActivityRow entry={entry} key={`${entry.at}-${i}`} />
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </section>
  )
}

function ActivityRow({ entry }: { entry: AuditEntry }) {
  const oneLine = entry.sql.replace(/\s+/g, ' ').trim()
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(entry.at)}</TableCell>
      <TableCell className="max-w-[8rem] truncate">{entry.actor}</TableCell>
      <TableCell className="max-w-[8rem] truncate">{entry.connectionName}</TableCell>
      <TableCell className="whitespace-nowrap capitalize">{entry.access}</TableCell>
      <TableCell className="max-w-[10rem]">
        {entry.ok ? (
          <Badge variant="success">OK</Badge>
        ) : (
          <Badge className="max-w-full" title={entry.error} variant="error">
            <span className="truncate">{entry.error ?? 'Failed'}</span>
          </Badge>
        )}
      </TableCell>
      {/* w-full with max-w-0: the cell takes whatever width is left and never pushes the table wider */}
      <TableCell className="w-full max-w-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <button className="block w-full cursor-default truncate text-left font-mono text-xs" type="button" />
            }
          >
            {oneLine}
          </TooltipTrigger>
          <TooltipPopup className="max-w-md whitespace-pre-wrap break-words font-mono text-xs">
            {entry.sql}
          </TooltipPopup>
        </Tooltip>
      </TableCell>
    </TableRow>
  )
}
