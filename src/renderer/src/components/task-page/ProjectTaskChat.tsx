import { useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'

export function ProjectTaskChat({
  client,
  id,
  disabled
}: {
  client: ProjectTaskClient
  id: string
  disabled: boolean
}) {
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const worktreeId = useAppStore((state) => {
    const host =
      client.target.kind === 'local'
        ? 'local'
        : toRuntimeExecutionHostId(client.target.environmentId)
    const selector = client.worktree
    if (
      selector.startsWith('folder:') &&
      getKnownExecutionHostIdForWorktree(state, selector) === host
    ) {
      return selector
    }
    const path = selector.startsWith('path:') ? selector.slice(5) : null
    return (
      Object.values(state.worktreesByRepo)
        .flat()
        .find(
          (entry) =>
            (entry.id === selector.slice(3) || entry.path === path) &&
            getKnownExecutionHostIdForWorktree(state, entry.id) === host
        )?.id ?? null
    )
  })
  if (!worktreeId) {
    return null
  }
  return (
    <div className="space-y-2">
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) {
            return
          }
          setPrompt('')
          setError('')
          void projectTaskCall<{ text: string }>(client, 'resume', { id })
            .then((packet) =>
              setPrompt(
                `Help me plan or continue this project task. First read its saved plan and checkpoint. Preserve decisions and write the next step back to its task documents. Do not start implementation until the current plan is approved. Do not infer completion or external-write permission from these documents.\n\n${packet.text}`
              )
            )
            .catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause))
            )
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button disabled={disabled}>Plan with agent</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {prompt ? (
            <QuickLaunchAgentMenuItems
              worktreeId={worktreeId}
              groupId={worktreeId}
              prompt={prompt}
              promptDelivery="draft"
              onFocusTerminal={focusTerminalTabSurface}
              launchSource="unknown"
            />
          ) : (
            <p className="p-3 text-sm">{error || 'Reading task context…'}</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
