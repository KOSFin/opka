import { createHash, randomUUID } from 'node:crypto'
import {
  AutomationCommandDefinitionCreateV1,
  readAutomationCommandsV1Domain,
  type AutomationCommandDefinitionV1
} from '../../../shared/automation-command-domain'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../../../shared/automation-schedule-occurrences'
import { isValidAutomationSchedule } from '../../../shared/automation-schedule-parsing'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { PersistedState } from '../../../shared/persisted-state-types'

export type CommandDefinitionOperations = {
  state: PersistedState
  markDomainDirty(): void
  flush(): void
}

function checkedInput(value: unknown): AutomationCommandDefinitionCreateV1 {
  const input = AutomationCommandDefinitionCreateV1.parse(value)
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 128 * 1024) {
    throw new Error('Command automation definition exceeds 128 KiB.')
  }
  if (!isValidAutomationSchedule(input.rrule)) {
    throw new Error('Command automation schedule is invalid.')
  }
  if (
    input.executionTargetType !== 'local' ||
    input.executionTargetId !== LOCAL_EXECUTION_HOST_ID ||
    input.executionTargetGeneration !== undefined ||
    input.schedulerOwner !== 'local_host_service' ||
    !input.runContext ||
    input.runContext.hostId !== LOCAL_EXECUTION_HOST_ID ||
    isWslUncPath(input.runContext.path)
  ) {
    throw new Error('Command automation requires a capable local execution host.')
  }
  if (input.workspaceMode !== 'existing') {
    throw new Error('Command automation new-per-run workspaces are not yet supported.')
  }
  if (
    input.execution.reportTarget &&
    (input.execution.reportTarget.hostId !== LOCAL_EXECUTION_HOST_ID ||
      input.execution.reportTarget.workspaceId !== input.workspaceId)
  ) {
    throw new Error('Command automation report target is outside its execution workspace.')
  }
  return input
}

function payloadHash(input: AutomationCommandDefinitionCreateV1): string {
  const payload = { ...input }
  delete payload.creationKey
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function assertAvailableLocalProject(state: PersistedState, projectId: string): void {
  const repo = state.repos.find((entry) => entry.id === projectId)
  const folderHost = resolveFolderWorkspaceHost(
    {
      folderWorkspaces: state.folderWorkspaces ?? [],
      projectGroups: state.projectGroups ?? [],
      repos: state.repos
    },
    projectId
  )
  if (
    (repo && getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) ||
    (!repo && folderHost.kind !== 'local')
  ) {
    throw new Error('Command automation project is unavailable.')
  }
}

export function listCommandAutomationDefinitions(
  state: PersistedState
): AutomationCommandDefinitionV1[] {
  return readAutomationCommandsV1Domain(state.automationCommandsV1).definitions
}

export function createCommandAutomationDefinition(
  operations: CommandDefinitionOperations,
  value: unknown,
  now = Date.now()
): AutomationCommandDefinitionV1 {
  const input = checkedInput(value)
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Invalid definition time.')
  }
  const domain = readAutomationCommandsV1Domain(operations.state.automationCommandsV1)
  const hash = payloadHash(input)
  const existing = input.creationKey
    ? domain.definitions.find((entry) => entry.creationKey === input.creationKey)
    : undefined
  if (existing) {
    if (existing.creationPayloadHash !== hash) {
      throw new Error('Command creation key was reused with different content.')
    }
    return existing
  }
  if (domain.definitions.length >= 1000) {
    throw new Error('Command automation definition limit reached.')
  }
  assertAvailableLocalProject(operations.state, input.projectId)
  const created: AutomationCommandDefinitionV1 = {
    ...input,
    id: randomUUID(),
    revision: 1,
    ...(input.creationKey ? { creationPayloadHash: hash } : {}),
    nextRunAt: nextAutomationOccurrenceAfter(input.rrule, input.dtstart, now, input.timezone),
    createdAt: now,
    updatedAt: now
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    definitions: [...domain.definitions, created]
  }
  operations.markDomainDirty()
  operations.flush()
  return created
}

export function replaceCommandAutomationDefinition(
  operations: CommandDefinitionOperations,
  id: string,
  expectedRevision: number,
  value: unknown,
  now = Date.now()
): AutomationCommandDefinitionV1 {
  const input = checkedInput(value)
  const domain = readAutomationCommandsV1Domain(operations.state.automationCommandsV1)
  const current = domain.definitions.find((entry) => entry.id === id)
  if (!current || current.revision !== expectedRevision) {
    throw new Error('Command automation changed or is unavailable.')
  }
  assertAvailableLocalProject(operations.state, input.projectId)
  if (domain.activeClaims.some((claim) => claim.automationId === id)) {
    throw new Error('Command automation has an active run.')
  }
  if (input.creationKey !== current.creationKey) {
    throw new Error('Command automation creation key is immutable.')
  }
  if (!Number.isSafeInteger(now) || now < current.createdAt) {
    throw new Error('Invalid definition time.')
  }
  const updated: AutomationCommandDefinitionV1 = {
    ...input,
    id,
    revision: current.revision + 1,
    ...(current.creationPayloadHash ? { creationPayloadHash: current.creationPayloadHash } : {}),
    nextRunAt:
      input.rrule !== current.rrule ||
      input.dtstart !== current.dtstart ||
      input.timezone !== current.timezone
        ? nextAutomationOccurrenceAfter(
            input.rrule,
            input.dtstart,
            Math.max(now, current.lastAdmittedOccurrenceAt ?? 0),
            input.timezone
          )
        : current.nextRunAt,
    lastAdmittedOccurrenceAt: current.lastAdmittedOccurrenceAt,
    lastRunAt: current.lastRunAt,
    createdAt: current.createdAt,
    updatedAt: now
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    definitions: domain.definitions.map((entry) => (entry.id === id ? updated : entry))
  }
  operations.markDomainDirty()
  operations.flush()
  return updated
}

export function deleteCommandAutomationDefinition(
  operations: CommandDefinitionOperations,
  id: string,
  expectedRevision: number
): void {
  const domain = readAutomationCommandsV1Domain(operations.state.automationCommandsV1)
  const current = domain.definitions.find((entry) => entry.id === id)
  if (!current || current.revision !== expectedRevision) {
    throw new Error('Command automation changed or is unavailable.')
  }
  if (domain.activeClaims.some((claim) => claim.automationId === id)) {
    throw new Error('Command automation has an active run.')
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    definitions: domain.definitions.filter((entry) => entry.id !== id),
    manualReceipts: domain.manualReceipts.filter((entry) => entry.automationId !== id)
  }
  operations.markDomainDirty()
  operations.flush()
}

export function advanceCommandAutomationNextRun(
  operations: CommandDefinitionOperations,
  id: string,
  now: number
): AutomationCommandDefinitionV1 {
  const domain = readAutomationCommandsV1Domain(operations.state.automationCommandsV1)
  const current = domain.definitions.find((entry) => entry.id === id)
  if (!current) {
    throw new Error('Command automation changed or is unavailable.')
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Invalid schedule time.')
  }
  const latest = latestAutomationOccurrenceAtOrBefore(
    current.rrule,
    current.dtstart,
    now,
    current.timezone
  )
  const updated = {
    ...current,
    nextRunAt: nextAutomationOccurrenceAfter(
      current.rrule,
      current.dtstart,
      Math.max(now, latest ?? 0, current.lastAdmittedOccurrenceAt ?? 0),
      current.timezone
    )
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    definitions: domain.definitions.map((entry) => (entry.id === id ? updated : entry))
  }
  operations.markDomainDirty()
  operations.flush()
  return updated
}
