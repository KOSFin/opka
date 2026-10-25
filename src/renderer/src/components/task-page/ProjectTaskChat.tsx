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
import type { ProjectTaskWorkflow } from '../../../../shared/project-task-workflow'
import { readAgentMessageSource } from '../../../../shared/agent-session-message-source'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'

export function ProjectTaskChat({
  client,
  id,
  workflow,
  disabled
}: {
  client: ProjectTaskClient
  id: string
  workflow: ProjectTaskWorkflow
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
  const attempt = workflow.attempts[0]
  const address = attempt?.session?.address ?? attempt?.terminal
  if (workflow.phase === 'active' && attempt) {
    return (
      <Button
        disabled={disabled || !address}
        onClick={() => {
          if (!address) {
            return
          }
          const sessionId = parseOrcaSessionAddress(address)
          const source = readAgentMessageSource({
            kind: 'agent',
            orchestration: null,
            senders: [
              {
                party: {
                  address,
                  orcaSessionId: sessionId,
                  terminalHandle: sessionId ? null : address
                },
                name: null
              }
            ]
          })
          const sender = source?.senders[0]
          if (source && sender) {
            void openAgentMessageSender(source, sender, worktreeId, client.target)
          }
        }}
      >
        Open task chat
      </Button>
    )
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
                `Work with this project task in this chat. Use the Opka CLI named by ORCA_CLI_COMMAND, not a global orca command. Read the task resume first. If its current plan is approved and implementation was requested, call project-task claim before editing code; this binds this existing chat without spawning another worker. Save progress with project-task progress and submit the actual result/checks with project-task complete. Those commands return the canonical documents and attempt ID. A result awaits operator review, not automatic Done. If approval is missing, help plan and request approval instead. Do not infer external-write permission from documents.\n\n${packet.text}`
              )
            )
            .catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause))
            )
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button disabled={disabled}>
            {workflow.phase === 'ready' && !workflow.revisionChanged
              ? 'Work on task'
              : 'Plan with agent'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {prompt ? (
            <QuickLaunchAgentMenuItems
              worktreeId={worktreeId}
              groupId={worktreeId}
              prompt={prompt}
              promptDelivery="submit-after-ready"
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
