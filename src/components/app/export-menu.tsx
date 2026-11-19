import {
  ClipboardCopyIcon,
  CodeIcon,
  DatabaseIcon,
  DownloadIcon,
  FileCodeIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ListIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExportFormat } from '@/lib/export'

/** Formats the server streams for a whole table (see /api/export/table). */
export type WholeTableFormat = 'csv' | 'json' | 'ndjson' | 'sql'

export function ExportMenu({
  label,
  disabled,
  onExport,
  onCopy,
  onCopyQuery,
  wholeTable,
}: {
  label: string
  disabled?: boolean
  onExport: (format: ExportFormat) => void
  onCopy: () => void
  onCopyQuery?: () => void
  /** Adds a "Whole table" group that streams the full table from the server. */
  wholeTable?: { label: string; onExport: (format: WholeTableFormat) => void }
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger render={<Button aria-label="Export" disabled={disabled} size="icon-sm" variant="ghost" />} />
          }
        >
          <DownloadIcon />
        </TooltipTrigger>
        <TooltipPopup>Export</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuItem onClick={() => onExport('csv')}>
            <FileSpreadsheetIcon aria-hidden="true" />
            CSV
          </MenuItem>
          <MenuItem onClick={() => onExport('json')}>
            <FileJsonIcon aria-hidden="true" />
            JSON
          </MenuItem>
          <MenuItem onClick={() => onExport('sql')}>
            <FileCodeIcon aria-hidden="true" />
            SQL INSERT
          </MenuItem>
          <MenuItem onClick={() => onExport('md')}>
            <FileTextIcon aria-hidden="true" />
            Markdown table
          </MenuItem>
        </MenuGroup>
        {wholeTable && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{wholeTable.label}</MenuGroupLabel>
              <MenuItem onClick={() => wholeTable.onExport('csv')}>
                <FileSpreadsheetIcon aria-hidden="true" />
                CSV
              </MenuItem>
              <MenuItem onClick={() => wholeTable.onExport('json')}>
                <FileJsonIcon aria-hidden="true" />
                JSON
              </MenuItem>
              <MenuItem onClick={() => wholeTable.onExport('ndjson')}>
                <ListIcon aria-hidden="true" />
                JSON lines
              </MenuItem>
              <MenuItem onClick={() => wholeTable.onExport('sql')}>
                <DatabaseIcon aria-hidden="true" />
                SQL INSERT
              </MenuItem>
            </MenuGroup>
          </>
        )}
        <MenuSeparator />
        <MenuItem onClick={onCopy}>
          <ClipboardCopyIcon aria-hidden="true" />
          Copy to clipboard (TSV)
        </MenuItem>
        {onCopyQuery && (
          <MenuItem onClick={onCopyQuery}>
            <CodeIcon aria-hidden="true" />
            Copy SELECT query
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  )
}
