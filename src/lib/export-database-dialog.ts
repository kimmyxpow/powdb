import { create } from '@/lib/create-store'

/** Whether the database export dialog is open. Page state only, never persisted. */
export const useExportDatabaseDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
