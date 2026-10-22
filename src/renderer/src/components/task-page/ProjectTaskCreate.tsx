import { useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { projectTaskTemplate } from '../../../../shared/project-task-template'
import type { TaskProject } from '../../../../shared/project-task-contract'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'

export function ProjectTaskCreate({
  client,
  project,
  onClose,
  onCreated
}: {
  client: ProjectTaskClient
  project: TaskProject
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [source, setSource] = useState(project.sources[0]?.id ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project task</DialogTitle>
          <DialogDescription>
            Describe the outcome for this project. Repositories can be chosen when work starts.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="Task title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs to be accomplished?"
        />
        <Textarea
          aria-label="Task description"
          placeholder="Context, desired result, and what must not change (optional)"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        {project.sources.length > 1 && (
          <details className="text-sm text-muted-foreground">
            <summary>File location</summary>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger aria-label="Task source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {project.sources.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.id} · {entry.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </details>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !title.trim() || !source}
            onClick={() => {
              const uuid = createBrowserUuid(),
                id = `task-${uuid}`
              setBusy(true)
              const content = projectTaskTemplate({
                id,
                title: title.trim(),
                goal
              })
              void projectTaskCall(client, 'create', { source, slug: uuid, content })
                .then(() => onCreated(id))
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause))
                )
                .finally(() => setBusy(false))
            }}
          >
            {busy ? 'Creating…' : 'Create plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
