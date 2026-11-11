import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

type Props = {
  name: string | null
  busy: boolean
  onOpenChange(open: boolean): void
  onConfirm(): void
}

export function AutomationCommandRemoveDialog({
  name,
  busy,
  onOpenChange,
  onConfirm
}: Props): React.JSX.Element {
  return (
    <Dialog open={name !== null} onOpenChange={onOpenChange}>
      <DialogContent surface="security" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove command automation?</DialogTitle>
          <DialogDescription>
            {name} will stop running. Retained run reports remain in history.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
