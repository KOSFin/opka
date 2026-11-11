import { createUuidV4 } from '../../../../shared/uuid-v4'
import {
  AutomationCommandDefinitionCreateV1,
  type AutomationCommandDefinitionV1
} from '../../../../shared/automation-command-domain'
import type {
  AutomationCommandReportTarget,
  AutomationCommandReportTargetOption
} from '../../../../shared/automation-command-domain'
import type { AutomationCommandConditionV1 } from '../../../../shared/automation-command-execution'
import type { ProjectHostSetup } from '../../../../shared/project-types'

export type AutomationCommandDraft = {
  name: string
  setupId: string
  commandKind: 'shell' | 'python' | 'program'
  commandText: string
  programArgs: string
  condition: AutomationCommandConditionV1
  agentEnabled: boolean
  agentPrompt: string
  reportTarget: AutomationCommandReportTarget | null
  time: string
  timezone: string
  timeoutSeconds: string
}

export function emptyAutomationCommandDraft(): AutomationCommandDraft {
  return {
    name: '',
    setupId: '',
    commandKind: 'shell',
    commandText: '',
    programArgs: '',
    condition: 'never_agent',
    agentEnabled: false,
    agentPrompt: '',
    reportTarget: null,
    time: '09:00',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    timeoutSeconds: '900'
  }
}

export function draftFromCommandAutomation(
  definition: AutomationCommandDefinitionV1
): AutomationCommandDraft {
  const command = definition.execution.command
  const schedule = /BYHOUR=(\d+);BYMINUTE=(\d+)/.exec(definition.rrule)
  return {
    name: definition.name,
    setupId: definition.runContext?.projectHostSetupId ?? '',
    commandKind: command.kind === 'program' ? 'program' : command.language,
    commandText: command.kind === 'program' ? command.executable : command.text,
    programArgs: command.kind === 'program' ? command.argv.join('\n') : '',
    condition: definition.execution.condition,
    agentEnabled: definition.execution.agent !== null,
    agentPrompt: definition.execution.agent?.prompt ?? '',
    reportTarget: definition.execution.reportTarget,
    time: schedule ? `${schedule[1].padStart(2, '0')}:${schedule[2].padStart(2, '0')}` : '09:00',
    timezone: definition.timezone,
    timeoutSeconds: String(definition.execution.policy.timeoutSeconds)
  }
}

export function commandDefinitionFromDraft(
  draft: AutomationCommandDraft,
  setup: ProjectHostSetup,
  now: number,
  creationKey = createUuidV4(),
  reportTargets: readonly AutomationCommandReportTargetOption[] = []
) {
  if (setup.setupState !== 'ready' || setup.hostId !== 'local') {
    throw new Error('Select a ready project on this execution host.')
  }
  const time = /^(\d{2}):(\d{2})$/.exec(draft.time)
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) {
    throw new Error('Enter a valid daily time.')
  }
  const timeoutSeconds = Number(draft.timeoutSeconds)
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error('Timeout must be from 1 to 3600 seconds.')
  }
  const command =
    draft.commandKind === 'program'
      ? {
          kind: 'program' as const,
          executable: draft.commandText.trim(),
          argv: draft.programArgs.split('\n').filter((argument) => argument.length > 0)
        }
      : {
          kind: 'script' as const,
          language: draft.commandKind,
          text: draft.commandText
        }
  if (draft.agentEnabled && draft.condition === 'never_agent') {
    throw new Error('Choose a condition that can start the agent.')
  }
  if (
    draft.reportTarget &&
    !reportTargets.some(
      (option) =>
        option.setupId === setup.id &&
        JSON.stringify(option.target) === JSON.stringify(draft.reportTarget)
    )
  ) {
    throw new Error('Report chat changed or is unavailable on this project host.')
  }
  return AutomationCommandDefinitionCreateV1.parse({
    creationKey,
    name: draft.name.trim(),
    runContext: {
      kind: 'workspace-run',
      projectId: setup.projectId,
      hostId: 'local',
      projectHostSetupId: setup.id,
      repoId: setup.repoId,
      path: setup.path
    },
    sourceContext: null,
    projectId: setup.projectId,
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: draft.reportTarget?.workspaceId ?? null,
    baseBranch: null,
    timezone: draft.timezone.trim(),
    rrule: `FREQ=DAILY;BYHOUR=${Number(time[1])};BYMINUTE=${Number(time[2])}`,
    dtstart: now,
    enabled: true,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    execution: {
      version: 1,
      command,
      condition: draft.condition,
      agent: draft.agentEnabled
        ? { agentId: 'codex', prompt: draft.agentPrompt, sessionPolicy: 'ephemeral' }
        : null,
      reportTarget: draft.reportTarget,
      policy: {
        timeoutSeconds,
        commandTimeoutSeconds: timeoutSeconds,
        idempotent: false,
        maxAttempts: 1
      }
    }
  })
}
