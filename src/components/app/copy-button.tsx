import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { ButtonProps } from '@/components/ui/button'
import { copyText } from '@/lib/export'

/** Copies text and shows "Copied" for a moment. `children` is the idle label. */
export function CopyButton({
  text,
  label = 'Copy',
  size = 'sm',
  children = 'Copy',
}: {
  text: string
  label?: string
  size?: ButtonProps['size']
  children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <Button
      aria-label={label}
      onClick={() => {
        void copyText(text)
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      }}
      size={size}
      variant="outline"
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {copied ? 'Copied' : children}
    </Button>
  )
}
