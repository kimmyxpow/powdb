import { EyeIcon, LayersIcon, TableIcon, TablePropertiesIcon, UnplugIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RelationKind } from '@/lib/types'

export const relationIcons: Record<RelationKind, LucideIcon> = {
  r: TableIcon,
  p: TablePropertiesIcon,
  v: EyeIcon,
  m: LayersIcon,
  f: UnplugIcon,
}
