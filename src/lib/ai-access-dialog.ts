import { create } from '@/lib/create-store'

/** Whether the AI access dialog is open. Page state only, never persisted. */
export const useAiAccessDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
