import { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SecuritySurface } from '@/components/ui/security-surface'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { ProjectTaskAgentSettings } from '../../../../shared/project-task-agent-settings'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'
import { projectTaskError, type TaskProjectScope } from './project-task-projects'

const STATUS_LABELS = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  'needs-repair': 'Setup needs attention',
  customized: 'Custom instructions detected'
} as const

export function ProjectTaskBoardSettings({
  client,
  project,
  projects,
  onChoose
}: {
  client: ProjectTaskClient | null
  project: TaskProjectScope | undefined
  projects: TaskProjectScope[]
  onChoose: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const activeClient = useRef(client)
  const [loaded, setLoaded] = useState<{
    client: ProjectTaskClient
    settings: ProjectTaskAgentSettings
  } | null>(null)
  const [pendingClient, setPendingClient] = useState<ProjectTaskClient | null>(null)
  const pending = client !== null && pendingClient === client
  const [failure, setFailure] = useState<{ client: ProjectTaskClient; message: string } | null>(
    null
  )
  const settings = loaded?.client === client ? loaded.settings : null
  const error = failure?.client === client ? failure.message : ''
  useEffect(() => {
    activeClient.current = client
    if (!client) {
      return
    }
    let cancelled = false
    setPendingClient(client)
    setFailure(null)
    void projectTaskCall<ProjectTaskAgentSettings>(client, 'agentSettings', { action: 'reconcile' })
      .then((settings) => {
        if (!cancelled) {
          setLoaded({ client, settings })
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setFailure({ client, message: projectTaskError(cause) })
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPendingClient((current) => (current === client ? null : current))
        }
      })
    return () => {
      cancelled = true
      if (activeClient.current === client) {
        activeClient.current = null
      }
    }
  }, [client])
  const apply = async (action: 'enable' | 'disable' | 'reconcile') => {
    if (!client) {
      return
    }
    setPendingClient(client)
    setFailure(null)
    try {
      const settings = await projectTaskCall<ProjectTaskAgentSettings>(client, 'agentSettings', {
        action
      })
      if (activeClient.current === client) {
        setLoaded({ client, settings })
      }
    } catch (cause) {
      if (activeClient.current === client) {
        setFailure({ client, message: projectTaskError(cause) })
      }
    } finally {
      setPendingClient((current) => (current === client ? null : current))
    }
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Settings />
        Board settings
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Board settings</SheetTitle>
            <SheetDescription>
              Settings apply to this project, not an individual card.
            </SheetDescription>
          </SheetHeader>
          <SecuritySurface>
            <section
              className="scrollbar-sleek space-y-5 overflow-y-auto border-t p-4"
              aria-label="Project board settings"
            >
              <div className="space-y-2">
                <Label htmlFor="board-settings-project">Project</Label>
                <Select value={project?.key ?? ''} onValueChange={onChoose} disabled={pending}>
                  <SelectTrigger id="board-settings-project" aria-label="Board settings project">
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((entry) => (
                      <SelectItem key={entry.key} value={entry.key}>
                        {entry.name} · {entry.hostLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!client ? (
                <p className="text-sm text-muted-foreground">
                  {project
                    ? 'Set up task files for this project first.'
                    : 'Choose a project to configure its board.'}
                </p>
              ) : (
                <>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="board-agent-workflow">Agent task workflow</Label>
                      <Switch
                        id="board-agent-workflow"
                        checked={settings?.enabled ?? false}
                        disabled={pending || !settings || settings.state === 'customized'}
                        onCheckedChange={(enabled) => void apply(enabled ? 'enable' : 'disable')}
                      />
                    </div>
                    <p role="status" className="text-sm">
                      {pending
                        ? 'Checking project integration…'
                        : settings
                          ? STATUS_LABELS[settings.state]
                          : 'Status unavailable'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Enabled by default. New Codex and Claude chats can discover this project’s
                      cards and save progress and reports beside each task. This does not
                      automatically approve plans or accept results.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Start a new chat after changing this setting. Existing chats are unchanged.
                    </p>
                  </div>
                  {settings?.state === 'customized' && (
                    <p className="text-sm">
                      Your custom skill files are preserved. Review the files below before changing
                      this setting.
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="break-words text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  {(error || settings?.state === 'needs-repair') && (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void apply('reconcile')}
                    >
                      Retry setup
                    </Button>
                  )}
                  {settings && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Integration files</summary>
                      <div className="space-y-2 pt-3">
                        {settings.files.map((file) => (
                          <p key={file.path} className="break-all">
                            {file.path} · {file.state}
                          </p>
                        ))}
                        <p>
                          Only this project is changed. Global agent settings and AGENTS.md are
                          untouched.
                        </p>
                      </div>
                    </details>
                  )}
                </>
              )}
            </section>
          </SecuritySurface>
        </SheetContent>
      </Sheet>
    </>
  )
}
