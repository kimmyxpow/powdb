import { Link } from '@tanstack/react-router'
import { ArrowUpRightIcon, EllipsisIcon, KeyRoundIcon, LinkIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { dropColumnSql, dropConstraintSql, dropIndexSql } from '@/lib/ddl'
import { displayQualified } from '@/lib/sql'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatBytes, formatCount, relationKindLabel, timeAgo } from '@/lib/format'
import type { ColumnInfo, ConstraintInfo, RelationDetails } from '@/lib/types'
import { ColumnDialog, ConstraintDialog, DropDialog, IndexDialog, TableSettingsDialog } from './schema-editor'

const CONSTRAINT_LABELS: Record<ConstraintInfo['type'], string> = {
  p: 'Primary key',
  f: 'Foreign key',
  u: 'Unique',
  c: 'Check',
  x: 'Exclusion',
  t: 'Trigger',
  n: 'Not null',
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2 px-1">
        <h2 className="flex items-center gap-2 font-medium text-sm">
          {title}
          {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {action && <div className="ms-auto flex items-center gap-1">{action}</div>}
      </div>
      {children}
    </section>
  )
}

type Drop = { title: string; description: ReactNode; statement: string }

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium text-sm tabular-nums">{value}</span>
    </div>
  )
}

export function StructureView({
  details,
  connectionId,
  database,
  canEdit,
  onRenamed,
}: {
  details: RelationDetails | undefined
  connectionId: string
  database: string
  /** structure changes allowed (a table on a writable connection) */
  canEdit: boolean
  onRenamed?: (name: string) => void
}) {
  const [columnDialog, setColumnDialog] = useState<{ column: ColumnInfo | null } | null>(null)
  const [indexOpen, setIndexOpen] = useState(false)
  const [constraintOpen, setConstraintOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drop, setDrop] = useState<Drop | null>(null)
  if (!details) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  const isTableLike = details.kind === 'r' || details.kind === 'p' || details.kind === 'm'
  const fkConstraints = details.constraints.filter((c) => c.type === 'f')
  const editable = canEdit && (details.kind === 'r' || details.kind === 'p')
  const target = { connectionId, database, schema: details.schema }
  const fq = displayQualified(details.schema, details.name)
  const columnNames = details.columns.map((c) => c.name)
  const columnTypes = Object.fromEntries(details.columns.map((c) => [c.name, c.type]))
  const indexNames = details.indexes.map((i) => i.name)
  const constraintNames = details.constraints.map((c) => c.name)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Type" value={relationKindLabel(details.kind)} />
          <Stat label="Owner" value={details.owner} />
          <Stat label="Rows (estimate)" value={formatCount(details.estimatedRows)} />
          {isTableLike && <Stat label="Data size" value={formatBytes(details.tableBytes)} />}
          {isTableLike && <Stat label="Index size" value={formatBytes(details.indexBytes)} />}
          {isTableLike && <Stat label="Total size" value={formatBytes(details.totalBytes)} />}
        </div>
        {(details.comment || canEdit) && (
          <div className="-mt-4 flex items-start gap-2">
            <p className="min-w-0 flex-1 rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-sm">
              {details.comment ?? 'No description yet.'}
            </p>
            {canEdit && (
              <Button onClick={() => setSettingsOpen(true)} size="sm" variant="outline">
                <PencilIcon aria-hidden="true" />
                Edit name and description
              </Button>
            )}
          </div>
        )}

        <Section
          action={
            editable && (
              <Button onClick={() => setColumnDialog({ column: null })} size="xs" variant="outline">
                <PlusIcon aria-hidden="true" />
                Add column
              </Button>
            )
          }
          count={details.columns.length}
          title="Columns"
        >
          <Table variant="card">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Nullable</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Comment</TableHead>
                {editable && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {details.columns.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="text-muted-foreground tabular-nums">{c.position}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5 font-medium font-mono text-[13px]">
                      {c.name}
                      {c.isPrimaryKey && <KeyRoundIcon aria-label="Primary key" className="size-3 text-amber-500" />}
                      {c.foreignKey && (
                        <Link
                          className="inline-flex items-center gap-0.5 rounded px-1 font-normal font-sans text-blue-600 text-xs hover:bg-accent dark:text-blue-400"
                          params={{
                            connId: connectionId,
                            db: database,
                            schema: c.foreignKey.schema,
                            table: c.foreignKey.table,
                          }}
                          search={{}}
                          title={`References ${c.foreignKey.schema}.${c.foreignKey.table}(${c.foreignKey.column})`}
                          to="/c/$connId/$db/t/$schema/$table"
                        >
                          <LinkIcon aria-hidden="true" className="size-3" />
                          {c.foreignKey.table}
                        </Link>
                      )}
                      {c.isUnique && !c.isPrimaryKey && <Badge variant="outline">unique</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">
                    {c.type}
                    {c.enumValues && (
                      <span
                        className="mt-0.5 block max-w-xs truncate font-sans text-xs"
                        title={c.enumValues.join(', ')}
                      >
                        {c.enumValues.join(' · ')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {c.nullable ? (
                      <span className="text-muted-foreground">yes</span>
                    ) : (
                      <Badge variant="secondary">NOT NULL</Badge>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-56 truncate font-mono text-muted-foreground text-xs"
                    title={c.defaultValue ?? ''}
                  >
                    {c.identity === 'a'
                      ? 'identity (always)'
                      : c.identity === 'd'
                        ? 'identity (by default)'
                        : c.generated
                          ? `generated: ${c.defaultValue}`
                          : (c.defaultValue ?? '')}
                  </TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground text-xs" title={c.comment ?? ''}>
                    {c.comment}
                  </TableCell>
                  {editable && (
                    <TableCell className="py-0">
                      <RowMenu label={`Column ${c.name}`}>
                        <MenuItem onClick={() => setColumnDialog({ column: c })}>
                          <PencilIcon aria-hidden="true" />
                          Edit column…
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          disabled={details.columns.length === 1}
                          onClick={() =>
                            setDrop({
                              title: `Drop column ${c.name}?`,
                              description: (
                                <>
                                  Deletes <span className="font-mono text-foreground">{c.name}</span> and its values
                                  from <span className="font-mono">{fq}</span>. This cannot be undone.
                                </>
                              ),
                              statement: dropColumnSql(details.schema, details.name, c.name),
                            })
                          }
                          variant="destructive"
                        >
                          <Trash2Icon aria-hidden="true" />
                          Drop column…
                        </MenuItem>
                      </RowMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        {(details.indexes.length > 0 || editable) && (
          <Section
            action={
              editable && (
                <Button onClick={() => setIndexOpen(true)} size="xs" variant="outline">
                  <PlusIcon aria-hidden="true" />
                  Add index
                </Button>
              )
            }
            count={details.indexes.length}
            title="Indexes"
          >
            {details.indexes.length === 0 ? (
              <EmptyNote>No indexes yet.</EmptyNote>
            ) : (
              <Table variant="card">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Columns</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Scans</TableHead>
                    {editable && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {details.indexes.map((i) => (
                    <TableRow key={i.name}>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-[13px]" title={i.definition}>
                            {i.name}
                          </span>
                          {i.isPrimary ? (
                            <Badge variant="warning">primary</Badge>
                          ) : i.isUnique ? (
                            <Badge variant="info">unique</Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground text-xs">
                        {i.columns.join(', ')}
                        {i.predicate && <span className="block">WHERE {i.predicate}</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{i.method}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(i.size)}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {formatCount(i.scans)}
                      </TableCell>
                      {editable && (
                        <TableCell className="py-0">
                          {i.isConstraint ? (
                            <Tooltip>
                              <TooltipTrigger render={<span className="inline-flex" />}>
                                <Button aria-label={`Drop index ${i.name}`} disabled size="icon-xs" variant="ghost">
                                  <Trash2Icon />
                                </Button>
                              </TooltipTrigger>
                              <TooltipPopup>
                                This index belongs to a constraint. Drop the constraint instead.
                              </TooltipPopup>
                            </Tooltip>
                          ) : (
                            <Button
                              aria-label={`Drop index ${i.name}`}
                              onClick={() =>
                                setDrop({
                                  title: `Drop index ${i.name}?`,
                                  description: 'Queries that used it may get slower. The data is not touched.',
                                  statement: dropIndexSql(details.schema, i.name),
                                })
                              }
                              size="icon-xs"
                              variant="ghost"
                            >
                              <Trash2Icon />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        )}

        {(details.constraints.length > 0 || editable) && (
          <Section
            action={
              editable && (
                <Button onClick={() => setConstraintOpen(true)} size="xs" variant="outline">
                  <PlusIcon aria-hidden="true" />
                  Add constraint
                </Button>
              )
            }
            count={details.constraints.length}
            title="Constraints"
          >
            {details.constraints.length === 0 ? (
              <EmptyNote>No constraints yet.</EmptyNote>
            ) : (
              <Table variant="card">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Definition</TableHead>
                    {editable && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {details.constraints.map((c) => (
                    <TableRow key={c.name}>
                      <TableCell className="font-mono text-[13px]">{c.name}</TableCell>
                      <TableCell>
                        <Badge variant={c.type === 'p' ? 'warning' : c.type === 'f' ? 'info' : 'secondary'}>
                          {CONSTRAINT_LABELS[c.type]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-normal break-all font-mono text-muted-foreground text-xs">
                        {c.definition}
                      </TableCell>
                      {editable && (
                        <TableCell className="py-0">
                          {c.type !== 'n' && c.type !== 't' && (
                            <Button
                              aria-label={`Drop constraint ${c.name}`}
                              onClick={() =>
                                setDrop({
                                  title: `Drop constraint ${c.name}?`,
                                  description:
                                    c.type === 'p'
                                      ? 'Without a primary key, rows can only be edited through their physical position (ctid).'
                                      : 'PostgreSQL stops checking this rule. The data is not touched.',
                                  statement: dropConstraintSql(details.schema, details.name, c.name),
                                })
                              }
                              size="icon-xs"
                              variant="ghost"
                            >
                              <Trash2Icon />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        )}

        {(fkConstraints.length > 0 || details.referencedBy.length > 0) && (
          <Section title="Relationships">
            <div className="grid gap-3 md:grid-cols-2">
              <RelationshipList
                connectionId={connectionId}
                database={database}
                empty="This table does not reference other tables."
                items={fkConstraints.map((c) => ({
                  key: c.name,
                  schema: c.refSchema ?? details.schema,
                  table: c.refTable ?? '',
                  text: `${c.columns.join(', ')} → ${c.refTable}(${c.refColumns?.join(', ')})`,
                }))}
                title="References"
              />
              <RelationshipList
                connectionId={connectionId}
                database={database}
                empty="No other table references this one."
                items={details.referencedBy.map((r) => ({
                  key: `${r.schema}.${r.table}.${r.name}`,
                  schema: r.schema,
                  table: r.table,
                  text: `${r.table}(${r.columns.join(', ')}) → ${r.refColumns.join(', ')}`,
                }))}
                title="Referenced by"
              />
            </div>
          </Section>
        )}

        {details.triggers.length > 0 && (
          <Section count={details.triggers.length} title="Triggers">
            <div className="flex flex-col gap-2">
              {details.triggers.map((t) => (
                <div className="rounded-xl border bg-card px-4 py-3" key={t.name}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium font-mono text-[13px]">{t.name}</span>
                    {!t.enabled && <Badge variant="secondary">disabled</Badge>}
                  </div>
                  <p className="mt-1 break-all font-mono text-muted-foreground text-xs">{t.definition}</p>
                </div>
              ))}
            </div>
          </Section>
        )}

        {details.stats && isTableLike && (
          <Section title="Activity">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Sequential scans" value={formatCount(details.stats.seqScan)} />
              <Stat label="Index scans" value={formatCount(details.stats.idxScan)} />
              <Stat label="Live rows" value={formatCount(details.stats.liveTuples)} />
              <Stat label="Dead rows" value={formatCount(details.stats.deadTuples)} />
              <Stat
                label="Last vacuum"
                value={timeAgo(latest(details.stats.lastVacuum, details.stats.lastAutovacuum))}
              />
              <Stat
                label="Last analyze"
                value={timeAgo(latest(details.stats.lastAnalyze, details.stats.lastAutoanalyze))}
              />
            </div>
          </Section>
        )}
      </div>

      {editable && (
        <>
          <ColumnDialog
            column={columnDialog?.column ?? null}
            onOpenChange={(o) => !o && setColumnDialog(null)}
            open={columnDialog !== null}
            table={details.name}
            takenNames={columnNames}
            target={target}
          />
          <IndexDialog
            columnTypes={columnTypes}
            columns={columnNames}
            onOpenChange={setIndexOpen}
            open={indexOpen}
            table={details.name}
            takenNames={indexNames}
            target={target}
          />
          <ConstraintDialog
            columnTypes={columnTypes}
            columns={columnNames}
            onOpenChange={setConstraintOpen}
            open={constraintOpen}
            table={details.name}
            takenNames={constraintNames}
            target={target}
          />
        </>
      )}
      {canEdit && (
        <TableSettingsDialog
          details={details}
          onOpenChange={setSettingsOpen}
          onRenamed={onRenamed}
          open={settingsOpen}
          target={target}
        />
      )}
      <DropDialog
        description={drop?.description}
        onOpenChange={(o) => !o && setDrop(null)}
        open={drop !== null}
        statement={drop?.statement ?? null}
        target={target}
        title={drop?.title ?? ''}
      />
    </div>
  )
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed px-4 py-3 text-muted-foreground text-sm">{children}</p>
}

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label={`${label} actions`} size="icon-xs" variant="ghost" />}>
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">{children}</MenuPopup>
    </Menu>
  )
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) > Date.parse(b) ? a : b
}

function RelationshipList({
  title,
  items,
  empty,
  connectionId,
  database,
}: {
  title: string
  items: { key: string; schema: string; table: string; text: string }[]
  empty: string
  connectionId: string
  database: string
}) {
  return (
    <div className="rounded-xl border bg-card p-2">
      <div className="px-2 py-1.5 text-muted-foreground text-xs">{title}</div>
      {items.length === 0 ? (
        <p className="px-2 pb-2 text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul>
          {items.map((it) => (
            <li key={it.key}>
              <Link
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 font-mono text-xs hover:bg-accent"
                params={{ connId: connectionId, db: database, schema: it.schema, table: it.table }}
                search={{ tab: 'structure' }}
                to="/c/$connId/$db/t/$schema/$table"
              >
                <span className="min-w-0 flex-1 truncate">{it.text}</span>
                <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
