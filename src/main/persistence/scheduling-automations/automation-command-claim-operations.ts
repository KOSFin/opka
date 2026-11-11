import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { AutomationRun, AutomationRunTrigger } from '../../../shared/automations-types'
import {
  readAutomationCommandsV1Domain,
  type AutomationCommandClaimV1
} from '../../../shared/automation-command-domain'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import {
  nextAutomationRunNumber,
  pruneAutomationRuns
} from '../../../shared/automation-run-retention'
import {
  assertWslMoveProjectWritable,
  assertWslMoveWorkspaceWritable
} from '../moving-wsl-projects/wsl-move-scope-guard'
import { recordAutomationCommandOverlap } from './automation-command-overlap-operations'

const MANUAL_KEY_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_MANUAL_RECEIPTS_PER_AUTOMATION = 100

export type CommandRunClaimRequest = {
  automationId: string
  definitionRevision: number
  ownerHostId: string
  ownerHostGeneration: number
  scheduledFor: number
  trigger: AutomationRunTrigger
  manualRequest?: { key: string; createdAt: number; payloadHash: string }
  now: number
}

export type CommandRunClaimOperations = {
  state: PersistedState
  flush(): void
  markDomainsDirty(): void
  recordAutomationRunsMutation?(runs: readonly AutomationRun[]): void
}

export type CommandRunClaimResult =
  | { kind: 'claimed'; run: AutomationRun; claim: AutomationCommandClaimV1 }
  | { kind: 'replayed'; run: AutomationRun }
  | { kind: 'overlap'; activeRunId: string }

/** Mutate the command claim and existing run history before one profile flush. */
export function claimAutomationCommandRun(
  operations: CommandRunClaimOperations,
  request: CommandRunClaimRequest
): CommandRunClaimResult {
  const domain = readAutomationCommandsV1Domain(operations.state.automationCommandsV1)
  if (
    !Number.isSafeInteger(request.now) ||
    !Number.isSafeInteger(request.scheduledFor) ||
    request.scheduledFor < 0 ||
    request.scheduledFor > request.now
  ) {
    throw new Error('Command run time is invalid.')
  }
  const definition = domain.definitions.find((entry) => entry.id === request.automationId)
  if (!definition || !definition.enabled || definition.revision !== request.definitionRevision) {
    throw new Error('Command automation changed or is unavailable.')
  }
  if (
    request.ownerHostGeneration < 1 ||
    definition.executionTargetType !== 'local' ||
    definition.executionTargetId !== LOCAL_EXECUTION_HOST_ID ||
    definition.runContext?.hostId !== request.ownerHostId ||
    request.ownerHostId !== LOCAL_EXECUTION_HOST_ID
  ) {
    throw new Error('Command automation execution host is unsupported or changed.')
  }
  if (definition.runContext && isWslUncPath(definition.runContext.path)) {
    throw new Error('Command automation on a WSL workspace requires a newer host.')
  }
  const projectStore = {
    getRepo: (id: string) => operations.state.repos.find((repo) => repo.id === id),
    getFolderWorkspaces: () => operations.state.folderWorkspaces
  }
  const projectRef = operations.state.repos.some((repo) => repo.id === definition.projectId)
    ? { repoId: definition.projectId }
    : { folderWorkspaceId: definition.projectId }
  assertWslMoveProjectWritable(projectStore, projectRef)
  assertWslMoveWorkspaceWritable(projectStore, definition.workspaceId)

  if (request.trigger === 'manual') {
    const manual = request.manualRequest
    if (
      !manual ||
      !manual.key ||
      Buffer.byteLength(manual.key, 'utf8') > 128 ||
      !/^[0-9a-f]{64}$/.test(manual.payloadHash) ||
      !Number.isSafeInteger(manual.createdAt) ||
      manual.createdAt > request.now ||
      request.now - manual.createdAt > MANUAL_KEY_WINDOW_MS
    ) {
      throw new Error('Command run request key is missing or outside its replay window.')
    }
    const receipt = domain.manualReceipts.find(
      (entry) => entry.automationId === definition.id && entry.requestKey === manual.key
    )
    if (receipt) {
      if (receipt.payloadHash !== manual.payloadHash) {
        throw new Error('Command run request key was reused with different content.')
      }
      if (receipt.outcome === 'overlap') {
        return { kind: 'overlap', activeRunId: receipt.runId }
      }
      const run = operations.state.automationRuns.find((entry) => entry.id === receipt.runId)
      if (!run) {
        throw new Error('Command run receipt outlived its history row; update required.')
      }
      return { kind: 'replayed', run }
    }
    if (
      domain.manualReceipts.filter(
        (entry) =>
          entry.automationId === definition.id &&
          request.now - entry.createdAt <= MANUAL_KEY_WINDOW_MS
      ).length >= MAX_MANUAL_RECEIPTS_PER_AUTOMATION
    ) {
      throw new Error('Command run replay window is full.')
    }
  } else if (request.manualRequest) {
    throw new Error('Scheduled command runs cannot carry manual request keys.')
  }

  const active = domain.activeClaims.find((claim) => claim.automationId === definition.id)
  if (active) {
    return recordAutomationCommandOverlap(operations, domain, active, request)
  }
  if (domain.activeClaims.length > 0) {
    throw new Error('Command automation host concurrency limit reached.')
  }
  if (
    request.trigger === 'scheduled' &&
    definition.lastAdmittedOccurrenceAt !== undefined &&
    request.scheduledFor <= definition.lastAdmittedOccurrenceAt
  ) {
    throw new Error('Scheduled command occurrence was already admitted.')
  }
  const existing =
    request.trigger === 'scheduled'
      ? operations.state.automationRuns.find(
          (run) => run.automationId === definition.id && run.scheduledFor === request.scheduledFor
        )
      : undefined
  if (existing) {
    return { kind: 'replayed', run: existing }
  }

  const runId = randomUUID()
  const acquisitionId = randomUUID()
  const runNumber = nextAutomationRunNumber(
    operations.state.automationRuns.filter((run) => run.automationId === definition.id)
  )
  const run: AutomationRun = {
    id: runId,
    automationId: definition.id,
    runContext: definition.runContext ?? null,
    sourceContext: definition.sourceContext ?? null,
    title: `${definition.name} run ${runNumber}`,
    scheduledFor: request.scheduledFor,
    status: 'dispatching',
    trigger: request.trigger,
    workspaceId: definition.workspaceId,
    workspaceDisplayName: null,
    sessionKind: 'command',
    commandExecution: {
      version: 1,
      phase: 'acquiring',
      attempt: 1,
      observation: 'unverifiable',
      finalReason: null
    },
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: request.now,
    runNumber
  }
  const claim: AutomationCommandClaimV1 = {
    automationId: definition.id,
    runId,
    definitionRevision: definition.revision,
    hostId: request.ownerHostId,
    hostGeneration: request.ownerHostGeneration,
    acquisitionId,
    attempt: 1,
    phase: 'acquiring',
    createdAt: request.now,
    observation: 'unverifiable',
    processIntent: {
      backend: 'linux_cgroup_v1',
      unitName: `orca-automation-${acquisitionId}.scope`,
      childName: 'command',
      receiptDirectory: join(tmpdir(), `orca-automation-${acquisitionId}`)
    },
    runSnapshot: {
      title: run.title,
      scheduledFor: run.scheduledFor,
      trigger: run.trigger,
      workspaceId: run.workspaceId,
      createdAt: run.createdAt,
      runNumber
    }
  }
  operations.state.automationRuns = pruneAutomationRuns([...operations.state.automationRuns, run])
  operations.state.automationCommandsV1 = {
    ...domain,
    definitions: domain.definitions.map((entry) =>
      entry.id === definition.id && request.trigger === 'scheduled'
        ? { ...entry, lastAdmittedOccurrenceAt: request.scheduledFor }
        : entry
    ),
    activeClaims: [...domain.activeClaims, claim],
    manualReceipts:
      request.trigger === 'manual' && request.manualRequest
        ? [
            ...domain.manualReceipts.filter(
              (entry) => request.now - entry.createdAt <= MANUAL_KEY_WINDOW_MS
            ),
            {
              automationId: definition.id,
              requestKey: request.manualRequest.key,
              payloadHash: request.manualRequest.payloadHash,
              createdAt: request.manualRequest.createdAt,
              runId
            }
          ]
        : domain.manualReceipts
  }
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  operations.markDomainsDirty()
  operations.flush()
  return { kind: 'claimed', run, claim }
}
