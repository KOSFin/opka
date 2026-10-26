import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ProjectTaskPreview } from './ProjectTaskPreview'
import type { ProjectTaskEntry } from '../../../../shared/project-task-contract'
import type { ProjectTaskWorkflow } from '../../../../shared/project-task-workflow'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'
import { ProjectTaskConfirm, type ProjectTaskConfirmation } from './ProjectTaskConfirm'
import { ProjectTaskAttempts } from './ProjectTaskAttempts'
import { ProjectTaskChat } from './ProjectTaskChat'
import { ProjectTaskDocuments } from './ProjectTaskDocuments'
import { ProjectTaskRecordedEvents } from './ProjectTaskRecordedEvents'

export function ProjectTaskDetail({
  client,
  id,
  refresh,
  onDeleted,
  version,
  onDirtyChange
}: {
  client: ProjectTaskClient
  id: string
  refresh: () => void
  onDeleted: () => void
  version: string
  onDirtyChange: (dirty: boolean) => void
}) {
  const [task, setTask] = useState<ProjectTaskEntry | null>(null)
  const [workflow, setWorkflow] = useState<ProjectTaskWorkflow | null>(null)
  const [source, setSource] = useState('')
  const [title, setTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [tab, setTab] = useState<'preview' | 'source' | 'documents' | 'activity'>('preview')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [confirmation, setConfirmation] = useState<ProjectTaskConfirmation | null>(null)
  const dirtyDraft = useRef(false)
  useEffect(() => {
    let cancelled = false
    setError('')
    void Promise.all([
      projectTaskCall<ProjectTaskEntry>(client, 'show', { id }),
      projectTaskCall<ProjectTaskWorkflow>(client, 'workflow', { id })
    ])
      .then(([document, state]) => {
        if (cancelled) {
          return
        }
        setWorkflow(state)
        if (!dirtyDraft.current) {
          setTask(document)
          setSource(document.content)
          setTitle(document.title)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, id, reload, version])
  const dirty = !!task && source !== task.content
  const originalTitle = task?.title ?? ''
  useEffect(() => {
    onDirtyChange(dirty || (!!originalTitle && title !== originalTitle))
    return () => onDirtyChange(false)
  }, [dirty, title, originalTitle, onDirtyChange])
  const apply = async (operation: string, params: object = {}) => {
    if (!task) {
      return
    }
    await projectTaskCall(client, operation, { id, revision: task.revision, ...params })
    dirtyDraft.current = false
    setReload((value) => value + 1)
    refresh()
  }
  const confirm = (operation: string, label: string, params: object = {}, reason = false) =>
    setConfirmation({
      title: label,
      description: `Task: ${task?.title}. Revision: ${task?.revision}. This action applies only to this project task; it does not approve external GitLab/Kaiten writes.`,
      reason,
      run: async (evidence) => {
        await apply(operation, { ...params, ...(reason ? { reason: evidence } : {}) })
        if (
          operation === 'delete' ||
          (operation === 'archive' && 'archived' in params && params.archived === true)
        ) {
          onDeleted()
        }
      }
    })
  const perform = (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    void operation()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }
  if (!task || !workflow) {
    return (
      <div className="p-5" role="status">
        {error || 'Loading task…'}
      </div>
    )
  }
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Project task detail"
    >
      <header className="space-y-3 border-b p-4">
        {renaming && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              aria-label="Rename task"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={busy || dirty || !title.trim() || title === task.title}
              onClick={() => perform(() => apply('rename', { title }))}
            >
              Rename
            </Button>
          </div>
        )}
        {!workflow.attempts.length && (
          <Select
            value={
              ['ready', 'integration'].includes(workflow.phase)
                ? workflow.phase === 'ready'
                  ? 'draft'
                  : 'review'
                : workflow.phase
            }
            onValueChange={(phase) =>
              confirm(
                'move',
                phase === 'done' ? 'Complete task' : 'Move task',
                { phase },
                phase === 'done'
              )
            }
          >
            <SelectTrigger aria-label="Task status" disabled={dirty || busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Planned</SelectItem>
              <SelectItem value="active">In progress</SelectItem>
              <SelectItem value="review">Review</SelectItem>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
        )}
        <details className="text-xs text-muted-foreground">
          <summary>Task information · {workflow.phase}</summary>
          <p className="break-all pt-2">
            {task.path} · {workflow.phase} · {workflow.attempts.length} recent attempts
          </p>
          <p>
            {task.repos.length
              ? task.repos.join(', ')
              : 'Whole project · repositories are chosen during execution'}
          </p>
        </details>
        {workflow.revisionChanged && (
          <p role="status" className="text-sm text-muted-foreground">
            The plan changed after approval. Previous approval does not authorize this revision.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <ProjectTaskChat
            client={client}
            id={id}
            workflow={workflow}
            disabled={dirty || busy || workflow.archived}
          />
          {(!['ready', 'review', 'integration', 'done'].includes(workflow.phase) ||
            workflow.revisionChanged) && (
            <Button
              variant="outline"
              disabled={dirty || workflow.archived}
              onClick={() => confirm('approve', 'Approve current plan')}
            >
              Approve plan
            </Button>
          )}
          {workflow.attempts.length > 0 && ['review', 'integration'].includes(workflow.phase) && (
            <>
              <Button
                variant="outline"
                disabled={dirty}
                onClick={() => confirm('decide', 'Request changes', { action: 'changes' }, true)}
              >
                Request changes
              </Button>
              <Button
                variant="outline"
                disabled={dirty}
                onClick={() =>
                  confirm('decide', 'Send to integration', { action: 'integration' }, true)
                }
              >
                Integration
              </Button>
              <Button
                disabled={dirty}
                onClick={() =>
                  confirm('decide', 'Accept reviewed result', { action: 'accept' }, true)
                }
              >
                Accept result
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost">More actions</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  perform(async () => {
                    const packet = await projectTaskCall<{ text: string }>(client, 'resume', { id })
                    await navigator.clipboard.writeText(packet.text)
                  })
                }
              >
                Copy resume context
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={dirty}
                onSelect={() =>
                  confirm('archive', workflow.archived ? 'Restore task' : 'Archive task', {
                    archived: !workflow.archived
                  })
                }
              >
                {workflow.archived ? 'Restore' : 'Archive'}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={dirty}
                onSelect={() => confirm('delete', 'Delete task document (keep history and notes)')}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {workflow.attempts[0]?.session?.blocker && (
          <p role="status" className="text-sm">
            Waiting: {workflow.attempts[0].session.blocker}
          </p>
        )}
        {workflow.exportError && (
          <p role="alert" className="text-sm text-destructive">
            {workflow.exportError}{' '}
            <Button variant="link" onClick={() => perform(() => apply('retryExport'))}>
              Retry export
            </Button>
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </header>
      <nav className="flex gap-2 border-b px-4 py-2" aria-label="Task document views">
        {(['preview', 'source', 'documents', 'activity'] as const).map((value) => (
          <Button
            key={value}
            variant={tab === value ? 'secondary' : 'ghost'}
            onClick={() => setTab(value)}
          >
            {value === 'preview'
              ? 'Plan'
              : value === 'source'
                ? 'Edit plan'
                : value === 'documents'
                  ? 'Reports & notes'
                  : 'Activity'}
          </Button>
        ))}
        <Button variant="ghost" disabled={dirty} onClick={() => setReload((value) => value + 1)}>
          Reload
        </Button>
      </nav>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-4">
        <ProjectTaskDocuments
          key={id}
          client={client}
          id={id}
          active={tab === 'documents'}
          version={version}
          preferredPath={workflow.attempts[0]?.session?.reportPath}
        />
        {tab === 'preview' && (
          <ProjectTaskPreview client={client} path={task.path} body={task.body} />
        )}
        {tab === 'source' && (
          <div className="space-y-3">
            <Textarea
              variant="code"
              className="min-h-80"
              aria-label="Task Markdown source"
              value={source}
              onChange={(event) => {
                dirtyDraft.current = event.target.value !== task.content
                setSource(event.target.value)
              }}
            />
            <p className="text-xs text-muted-foreground">
              Saving edits invalidates previous approval. Concurrent changes are rejected; your
              draft remains here.
            </p>
            <p role="status" className="text-xs text-muted-foreground">
              {busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
            </p>
            <Button
              disabled={busy || !dirty}
              onClick={() => perform(() => apply('update', { content: source }))}
            >
              Save plan
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !dirty}
              onClick={() => {
                dirtyDraft.current = false
                setSource(task.content)
                setReload((value) => value + 1)
              }}
            >
              Discard draft
            </Button>
          </div>
        )}
        {tab === 'activity' && (
          <div className="space-y-4">
            <ProjectTaskAttempts
              client={client}
              task={task}
              workflow={workflow}
              refresh={() => {
                setReload((value) => value + 1)
                refresh()
              }}
            />
            <ProjectTaskRecordedEvents events={workflow.events} />
          </div>
        )}
      </div>
      <ProjectTaskConfirm action={confirmation} onClose={() => setConfirmation(null)} />
    </section>
  )
}
