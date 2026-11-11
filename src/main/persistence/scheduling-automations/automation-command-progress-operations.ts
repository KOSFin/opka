import {
  readAutomationCommandsV1Domain,
  type AutomationCommandClaimV1
} from '../../../shared/automation-command-domain'
import type { AutomationRun, AutomationRunOutputSnapshot } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'

export type CommandProgressOperations = {
  state: PersistedState
  markDomainsDirty(): void
  recordAutomationRunsMutation?(runs: readonly AutomationRun[]): void
  flush(): void
}

type Phase = AutomationCommandClaimV1['phase']
type Observation = NonNullable<AutomationCommandClaimV1['observation']>

const NEXT_PHASES: Record<Phase, readonly Phase[]> = {
  acquiring: ['command', 'report', 'unverifiable'],
  command: ['condition', 'report', 'unverifiable'],
  condition: ['agent', 'report', 'unverifiable'],
  agent: ['report', 'unverifiable'],
  report: ['report', 'unverifiable'],
  unverifiable: ['report']
}

export type CommandProgressFence = {
  automationId: string
  runId: string
  acquisitionId: string
  hostGeneration: number
  expectedPhase: Phase
}

export function readFencedClaim(
  operations: CommandProgressOperations,
  fence: CommandProgressFence
) {
  const domain = readAutomationCommandsV1Domain(operations.state.automationCommandsV1)
  const claim = domain.activeClaims.find((entry) => entry.automationId === fence.automationId)
  if (
    !claim ||
    claim.runId !== fence.runId ||
    claim.acquisitionId !== fence.acquisitionId ||
    claim.hostGeneration !== fence.hostGeneration ||
    claim.phase !== fence.expectedPhase
  ) {
    throw new Error('Command run acquisition changed or is unavailable.')
  }
  const run = operations.state.automationRuns.find((entry) => entry.id === fence.runId)
  if (!run || run.automationId !== fence.automationId || run.sessionKind !== 'command') {
    throw new Error('Command run history changed or is unavailable.')
  }
  return { domain, claim, run }
}

function boundedSnapshot(snapshot: AutomationRunOutputSnapshot | null): void {
  if (snapshot && Buffer.byteLength(snapshot.content, 'utf8') > 16 * 1024) {
    throw new Error('Command report exceeds 16 KiB.')
  }
}

export function advanceAutomationCommandRun(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  update: {
    phase: Phase
    observation: Observation
    outputSnapshot?: AutomationRunOutputSnapshot
    finalReason?: string | null
  }
): AutomationRun {
  const { domain, claim, run } = readFencedClaim(operations, fence)
  if (!NEXT_PHASES[claim.phase].includes(update.phase)) {
    throw new Error('Command run phase transition is invalid.')
  }
  if (
    (update.phase === 'condition' || update.phase === 'agent' || update.phase === 'report') &&
    update.observation !== 'exited'
  ) {
    throw new Error('Command continuation requires a proven preceding exit.')
  }
  if (update.finalReason && Buffer.byteLength(update.finalReason, 'utf8') > 4096) {
    throw new Error('Command final reason exceeds 4 KiB.')
  }
  boundedSnapshot(update.outputSnapshot ?? null)
  const updatedRun: AutomationRun = {
    ...run,
    ...(update.outputSnapshot ? { outputSnapshot: update.outputSnapshot } : {}),
    commandExecution: {
      version: 1,
      phase: update.phase,
      attempt: claim.attempt,
      observation: update.observation,
      finalReason: update.finalReason ?? run.commandExecution?.finalReason ?? null,
      ...(run.commandExecution?.overlapCount !== undefined
        ? { overlapCount: run.commandExecution.overlapCount }
        : {})
    }
  }
  const updatedClaim: AutomationCommandClaimV1 = {
    ...claim,
    phase: update.phase,
    observation: update.observation,
    runSnapshot: claim.runSnapshot
      ? {
          ...claim.runSnapshot,
          ...(update.outputSnapshot ? { outputSnapshot: update.outputSnapshot } : {}),
          ...(update.finalReason !== undefined ? { finalReason: update.finalReason } : {})
        }
      : undefined
  }
  operations.state.automationRuns = operations.state.automationRuns.map((entry) =>
    entry.id === run.id ? updatedRun : entry
  )
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((entry) =>
      entry.automationId === claim.automationId ? updatedClaim : entry
    )
  }
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  operations.markDomainsDirty()
  operations.flush()
  return updatedRun
}

export function requestAutomationCommandCancel(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  requestKey: string,
  now: number
): AutomationCommandClaimV1 {
  const { domain, claim } = readFencedClaim(operations, fence)
  if (!requestKey || Buffer.byteLength(requestKey, 'utf8') > 128) {
    throw new Error('Command cancel request key is invalid.')
  }
  if (!Number.isSafeInteger(now) || now < claim.createdAt) {
    throw new Error('Command cancel request time is invalid.')
  }
  if (claim.cancelRequestedAt !== undefined) {
    return claim
  }
  const updated = { ...claim, cancelRequestedAt: now, cancelRequestKey: requestKey }
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((entry) =>
      entry.automationId === claim.automationId ? updated : entry
    )
  }
  operations.markDomainsDirty()
  operations.flush()
  return updated
}

export function settleAutomationCommandRun(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  result: {
    status: 'completed' | 'skipped_precheck' | 'dispatch_failed'
    finalReason: string
    outputSnapshot?: AutomationRunOutputSnapshot | null
    deliveryStatus: 'history_only' | 'delivered' | 'failed'
  }
): AutomationRun {
  const { claim, run } = readFencedClaim(operations, fence)
  if (claim.phase !== 'report' || claim.observation !== 'exited') {
    throw new Error('Command run cannot settle without a proven exit and report stage.')
  }
  if (Buffer.byteLength(result.finalReason, 'utf8') > 4096) {
    throw new Error('Command final reason exceeds 4 KiB.')
  }
  boundedSnapshot(result.outputSnapshot ?? null)
  const updated: AutomationRun = {
    ...run,
    status: result.status,
    outputSnapshot: result.outputSnapshot ?? run.outputSnapshot,
    error: result.status === 'completed' ? null : result.finalReason,
    commandExecution: {
      version: 1,
      phase: 'settled',
      attempt: claim.attempt,
      observation: 'exited',
      finalReason: result.finalReason,
      ...(run.commandExecution?.overlapCount !== undefined
        ? { overlapCount: run.commandExecution.overlapCount }
        : {}),
      deliveryStatus: result.deliveryStatus
    }
  }
  operations.state.automationRuns = operations.state.automationRuns.map((entry) =>
    entry.id === run.id ? updated : entry
  )
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  operations.markDomainsDirty()
  operations.flush()
  return updated
}

/** Release only after the final run/report row has reached the durable authority. */
export function releaseAutomationCommandClaim(
  operations: CommandProgressOperations,
  fence: CommandProgressFence
): void {
  const { domain, claim, run } = readFencedClaim(operations, fence)
  if (
    claim.phase !== 'report' ||
    claim.observation !== 'exited' ||
    run.commandExecution?.phase !== 'settled'
  ) {
    throw new Error('Command report is not ready to release its claim.')
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.filter((entry) => entry.automationId !== claim.automationId)
  }
  operations.markDomainsDirty()
  operations.flush()
}
