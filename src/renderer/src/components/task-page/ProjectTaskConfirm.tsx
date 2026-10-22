import { useState } from 'react'
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
  reason?: boolean
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
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>{action?.title}</DialogTitle>
          <DialogDescription>{action?.description}</DialogDescription>
        </DialogHeader>
        {action?.reason && (
          <Textarea
            aria-label="Review evidence"
            placeholder="Result, checks performed, commit or MR links. This is an operator decision, not an automatic CI verification."
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
            disabled={busy || !!(action?.reason && !reason.trim())}
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
