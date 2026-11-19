import { anchoredToastManager, toastManager } from '@/components/ui/toast'
import { copyText } from '@/lib/export'

/** Error toast for a copy the browser refused. */
export function showCopyFailed(): void {
  toastManager.add({
    type: 'error',
    title: 'Could not copy',
    description: 'The browser blocked access to the clipboard.',
  })
}

/** Copies text and reports the result in a global toast. */
export async function copyWithToast(text: string, title: string, description?: string): Promise<void> {
  const ok = await copyText(text)
  if (ok) toastManager.add({ type: 'success', title, description, timeout: 2000 })
  else showCopyFailed()
}

/** Copies text and reports the result in a toast anchored to `anchor` (used inside the grid). */
export async function copyWithAnchoredToast(
  text: string,
  anchor: Element | null,
  title: string,
  timeout = 1200,
): Promise<void> {
  const ok = await copyText(text)
  anchoredToastManager.add({
    title: ok ? title : 'Could not copy',
    positionerProps: { anchor, side: 'top', sideOffset: 6 },
    timeout,
    data: { tooltipStyle: true },
  })
}
