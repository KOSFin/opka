import { AutomationCommandsV1Domain } from '../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'

/** Restore an active command claim after an older host finalized or pruned its run row. */
export function recoverActiveAutomationCommandRuns(
  parsed: PersistedState,
  runs: AutomationRun[],
  markNeedsSave: () => void
): AutomationRun[] {
  const domain = AutomationCommandsV1Domain.safeParse(parsed.automationCommandsV1)
  if (!domain.success || domain.data.activeClaims.length === 0) {
    return runs
  }
  const byId = new Map(runs.map((run) => [run.id, run]))
  let repaired = false
  const releasedClaims = new Set<string>()
  for (const claim of domain.data.activeClaims) {
    const existing = byId.get(claim.runId)
    if (existing && existing.automationId === claim.automationId) {
      if (
        claim.phase === 'report' &&
        claim.observation === 'exited' &&
        existing.commandExecution?.phase === 'settled' &&
        existing.commandExecution.deliveryStatus !== undefined
      ) {
        releasedClaims.add(claim.automationId)
        continue
      }
      if (
        existing.status === 'dispatching' &&
        existing.commandExecution?.phase === 'unverifiable'
      ) {
        continue
      }
      byId.set(claim.runId, {
        ...existing,
        status: 'dispatching',
        commandExecution: {
          version: 1,
          phase: 'unverifiable',
          attempt: claim.attempt,
          observation: 'unverifiable',
          finalReason: null,
          ...(claim.overlapCount !== undefined ? { overlapCount: claim.overlapCount } : {})
        }
      })
      repaired = true
      continue
    }
    const snapshot = claim.runSnapshot
    const definition = domain.data.definitions.find((entry) => entry.id === claim.automationId)
    if (!snapshot || !definition) {
      continue
    }
    byId.set(claim.runId, {
      id: claim.runId,
      automationId: claim.automationId,
      runContext: definition.runContext,
      sourceContext: definition.sourceContext,
      title: snapshot.title,
      scheduledFor: snapshot.scheduledFor,
      status: 'dispatching',
      trigger: snapshot.trigger,
      workspaceId: snapshot.workspaceId,
      workspaceDisplayName: null,
      sessionKind: 'command',
      commandExecution: {
        version: 1,
        phase: 'unverifiable',
        attempt: claim.attempt,
        observation: 'unverifiable',
        finalReason: null,
        ...(claim.overlapCount !== undefined ? { overlapCount: claim.overlapCount } : {})
      },
      chatSessionId: null,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null,
      outputSnapshot: snapshot.outputSnapshot ?? null,
      precheckResult: null,
      usage: null,
      error: snapshot.finalReason ?? null,
      startedAt: null,
      dispatchedAt: null,
      createdAt: snapshot.createdAt,
      runNumber: snapshot.runNumber
    })
    repaired = true
  }
  if (releasedClaims.size > 0) {
    parsed.automationCommandsV1 = {
      ...domain.data,
      activeClaims: domain.data.activeClaims.filter(
        (claim) => !releasedClaims.has(claim.automationId)
      )
    }
    markNeedsSave()
  }
  if (repaired) {
    markNeedsSave()
  }
  return repaired ? [...byId.values()] : runs
}
