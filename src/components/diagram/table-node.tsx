import { ExternalLinkIcon, KeyRoundIcon, LinkIcon } from 'lucide-react'
import { memo } from 'react'
import { relationIcons } from '@/components/app/relation-icons'
import { Button } from '@/components/ui/button'
import { CARD_HEADER_HEIGHT, CARD_ROW_HEIGHT, type DiagramNode } from '@/lib/diagram-layout'

interface TableNodeProps {
  /** layout data (size and columns); stable between position changes so memo holds */
  node: DiagramNode
  x: number
  y: number
  selected: boolean
  dimmed: boolean
  onOpen: (schema: string, table: string) => void
}

// The border is a box-shadow so the card's box is exactly the anchor geometry (no border offset).
const BORDER_SHADOW = '0 0 0 1px var(--border), 0 1px 2px rgb(0 0 0 / 0.06)'
const SELECTED_SHADOW = '0 0 0 2px var(--primary)'

/** A table card: header (drag handle) and one row per visible column. */
export const TableNode = memo(function TableNode({ node, x, y, selected, dimmed, onOpen }: TableNodeProps) {
  const ghost = node.kind === 'ghost'
  const Icon = node.kind === 'ghost' ? LinkIcon : relationIcons[node.kind]

  return (
    <div
      className="absolute overflow-hidden rounded-lg bg-card text-card-foreground transition-opacity duration-150"
      data-node={node.id}
      style={{
        left: x,
        top: y,
        width: node.width,
        height: node.height,
        boxShadow: selected ? SELECTED_SHADOW : BORDER_SHADOW,
        opacity: dimmed ? 0.3 : 1,
      }}
    >
      <div
        className="flex cursor-move items-center gap-2 border-b border-border px-2.5"
        data-node-header=""
        style={{ height: CARD_HEADER_HEIGHT }}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-baseline gap-1">
          {ghost && <span className="shrink-0 truncate text-muted-foreground text-xs">{node.schema}.</span>}
          <span className="truncate font-medium text-sm">{node.name}</span>
        </div>
        <Button
          aria-label="Open table"
          className="size-6 shrink-0"
          onClick={() => onOpen(node.schema, node.name)}
          size="icon-xs"
          title="Open table"
          variant="ghost"
        >
          <ExternalLinkIcon />
        </Button>
      </div>

      {node.columns.map((col) => (
        <div
          key={col.name}
          className="flex items-center gap-1.5 px-2.5 text-xs"
          data-column={col.name}
          data-table={node.id}
          style={{ height: CARD_ROW_HEIGHT }}
        >
          <span className="flex size-3 shrink-0 items-center justify-center">
            {col.isPrimaryKey ? (
              <KeyRoundIcon aria-label="Primary key" className="size-3" />
            ) : col.isForeignKey ? (
              <LinkIcon aria-label="Foreign key" className="size-3 text-muted-foreground" />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{col.name}</span>
          {col.type && <span className="max-w-[45%] shrink truncate text-muted-foreground">{col.type}</span>}
        </div>
      ))}

      {node.hiddenColumns > 0 && (
        <div className="flex items-center px-2.5 text-muted-foreground text-xs" style={{ height: CARD_ROW_HEIGHT }}>
          +{node.hiddenColumns} more columns
        </div>
      )}
    </div>
  )
})
