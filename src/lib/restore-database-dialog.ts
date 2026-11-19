import { create } from '@/lib/create-store'

/** Whether the restore database dialog is open. Page state only, never persisted. */
export const useRestoreDatabaseDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
