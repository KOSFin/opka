import type React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

export function CloneGitLabProfileRemovalDialog({
  open,
  onOpenChange,
  pending,
  onRemove
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onRemove: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent surface="security" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove GitLab profile?</DialogTitle>
          <DialogDescription>
            Bound fetch and push will stop until another verified profile is selected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" className="min-h-11" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="min-h-11"
            autoFocus
            disabled={pending}
            onClick={onRemove}
          >
            {pending ? 'Removing…' : 'Remove profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
