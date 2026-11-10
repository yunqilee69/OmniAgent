/** Clipboard writes with component-owned success feedback and cleanup. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { writeClipboard } from './clipboard.ts'

/** Clipboard action and its temporary success state. */
export interface ClipboardCopyState {
  /** True for one second after an accepted clipboard write. */
  readonly copied: boolean
  /** True briefly when the host rejected the clipboard write. */
  readonly failed: boolean
  /** Write the current text unless a write or success indication is already active. */
  readonly onCopy: () => void
}

/**
 * Keep clipboard feedback local to the mounted control and release its reset timer on unmount.
 * @param text - Exact text to copy when the action is invoked.
 * @returns Success feedback and a callback stable while text and feedback are unchanged.
 */
export function useClipboardCopy(text: string): ClipboardCopyState {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<number | null>(null)
  const copyEpoch = useRef(0)
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])
  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = null
    setFailed(false)
    copyPending.current = true
    void writeClipboard(text).then((ok) => {
      if (epoch !== copyEpoch.current) return
      copyPending.current = false
      if (ok) setCopied(true)
      else setFailed(true)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
        setFailed(false)
      }, ok ? 1000 : 3000)
    })
  }, [copied, text])
  return { copied, failed, onCopy }
}
