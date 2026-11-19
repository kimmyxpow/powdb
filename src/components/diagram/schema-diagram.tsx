import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { BracesIcon, SearchIcon, WandSparklesIcon } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { relationIcons } from '@/components/app/relation-icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { useSelectedSchema } from '@/hooks/use-selected-schema'
import { DIAGRAM_TABLE_LIMIT, schemaDiagramQuery } from '@/lib/diagram'
import { layoutSchemaDiagram } from '@/lib/diagram-layout'
import { schemasQuery } from '@/lib/queries'
import { DiagramCanvas, type DiagramCanvasHandle } from './diagram-canvas'

export function SchemaDiagram({ connectionId, database }: { connectionId: string; database: string }) {
  const navigate = useNavigate()
  const canvas = useRef<DiagramCanvasHandle>(null)
  const [showAllColumns, setShowAllColumns] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const { data: schemas } = useQuery(schemasQuery(connectionId, database))
  const [selectedSchema, setSchema] = useSelectedSchema(connectionId, database)
  // databases without a "public" schema: fall back to the first user schema (as the sidebar does)
  const schema =
    schemas && !schemas.some((s) => s.name === selectedSchema)
      ? (schemas.find((s) => !s.isSystem)?.name ?? selectedSchema)
      : selectedSchema

  const schemaItems = [...(schemas ?? [])]
    .sort((a, b) => Number(a.isSystem) - Number(b.isSystem))
    .map((s) => ({ label: s.name, value: s.name }))
  if (!schemaItems.some((s) => s.value === schema)) schemaItems.push({ label: schema, value: schema })

  const { data, error, isPending } = useQuery({
    ...schemaDiagramQuery(connectionId, database, schema),
    enabled: Boolean(schemas),
  })

  const autoNodes = data ? layoutSchemaDiagram(data, { showAllColumns }) : null

  // a selection from another schema is meaningless here
  const activeId = autoNodes && selectedId && autoNodes.some((n) => n.id === selectedId) ? selectedId : null

  const needle = query.trim().toLowerCase()
  const matches = needle && data ? data.tables.filter((t) => t.name.toLowerCase().includes(needle)).slice(0, 8) : []

  const pick = (name: string) => {
    if (!data) return
    const id = `${data.schema}.${name}`
    setSelectedId(id)
    setQuery('')
    canvas.current?.centerOn(id)
  }

  const openTable = useCallback(
    (tableSchema: string, table: string) => {
      void navigate({
        to: '/c/$connId/$db/t/$schema/$table',
        params: { connId: connectionId, db: database, schema: tableSchema, table },
      })
    },
    [navigate, connectionId, database],
  )

  const errorMessage = error ? (error instanceof Error ? error.message : String(error)) : null
  const hasTables = Boolean(data && data.tables.length > 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Select
          items={schemaItems}
          onValueChange={(v) => {
            if (!v) return
            setSelectedId(null)
            setSchema(v)
          }}
          value={schema}
        >
          <SelectTrigger aria-label="Schema" className="w-44 min-w-0 bg-background" size="sm">
            <span className="flex min-w-0 items-center gap-2">
              <BracesIcon aria-hidden="true" className="size-3.5 opacity-60" />
              <SelectValue className="truncate" />
            </span>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {schemaItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        <div className="relative w-56 max-w-full">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Find table"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches[0]) {
                  e.preventDefault()
                  pick(matches[0].name)
                } else if (e.key === 'Escape') {
                  setQuery('')
                }
              }}
              placeholder="Find table…"
              size="sm"
              type="search"
              value={query}
            />
          </InputGroup>
          {matches.length > 0 && (
            <div className="absolute start-0 end-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg">
              {matches.map((t) => {
                const Icon = relationIcons[t.kind]
                return (
                  <button
                    key={t.name}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent"
                    onClick={() => pick(t.name)}
                    onMouseDown={(e) => e.preventDefault()}
                    type="button"
                  >
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{t.name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <Button disabled={!hasTables} onClick={() => canvas.current?.fit()} size="sm" variant="outline">
          Fit
        </Button>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button disabled={!hasTables} onClick={() => canvas.current?.autoLayout()} size="sm" variant="outline" />
            }
          >
            <WandSparklesIcon aria-hidden="true" />
            Auto layout
          </TooltipTrigger>
          <TooltipPopup>Arrange tables again</TooltipPopup>
        </Tooltip>

        <div className="flex items-center gap-2">
          <Switch checked={showAllColumns} id="diagram-columns" onCheckedChange={setShowAllColumns} />
          <Label htmlFor="diagram-columns">Columns</Label>
        </div>

        {data?.truncated && (
          <span className="ms-auto text-muted-foreground text-xs">Showing the first {DIAGRAM_TABLE_LIMIT} tables.</span>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {errorMessage !== null ? (
          <div className="p-4">
            <Alert variant="error">
              <AlertTitle>Could not load the diagram</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          </div>
        ) : isPending || !data || !autoNodes ? (
          <div className="absolute inset-0 p-6">
            <Skeleton className="h-full w-full rounded-lg" />
          </div>
        ) : data.tables.length === 0 ? (
          <Empty className="absolute inset-0">
            <EmptyHeader>
              <EmptyTitle>This schema has no tables.</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <DiagramCanvas
            autoNodes={autoNodes}
            connectionId={connectionId}
            database={database}
            diagram={data}
            key={data.schema}
            onOpen={openTable}
            onSelect={setSelectedId}
            ref={canvas}
            selectedId={activeId}
          />
        )}
      </div>
    </div>
  )
}
