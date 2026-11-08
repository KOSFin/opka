import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

export type ProjectTaskConfirmation = {
  title: string
  description: string
  reason?: boolean | 'optional'
  focusConfirm?: boolean
  run: (reason: string) => Promise<void>
}
export function ProjectTaskConfirm({
  action,
  onClose
}: {
  action: ProjectTaskConfirmation | null
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const primary = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const dismiss = () => {
    setReason('')
    setError('')
    onClose()
  }
  return (
    <Dialog
      open={!!action}
      onOpenChange={(open) => {
        if (!open && !busy) {
          dismiss()
        }
      }}
    >
      <DialogContent
        surface="security"
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
          if (action?.focusConfirm) {
            event.preventDefault()
            primary.current?.focus()
          }
        }}
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault()
            opener.current.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{action?.title}</DialogTitle>
          <DialogDescription>{action?.description}</DialogDescription>
        </DialogHeader>
        {action?.reason && (
          <Textarea
            aria-label={action.reason === 'optional' ? 'Comment (optional)' : 'Review evidence'}
            placeholder={
              action.reason === 'optional'
                ? 'Comment (optional)'
                : 'Describe the result or requested changes'
            }
            maxLength={2000}
            onKeyDown={(event) => {
              const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
              if (event.key === 'Enter' && modifier && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (!event.repeat) {
                  primary.current?.click()
                }
              }
            }}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={dismiss}>
            Cancel
          </Button>
          <Button
            ref={primary}
            disabled={busy || (action?.reason === true && !reason.trim())}
            onClick={() => {
              if (!action) {
                return
              }
              setBusy(true)
              setError('')
              void action
                .run(reason)
                .then(() => {
                  onClose()
                  setReason('')
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause))
                )
                .finally(() => setBusy(false))
            }}
          >
            {busy ? 'Applying…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
