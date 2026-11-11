import type {
  AutomationCommandClaimV1,
  AutomationCommandsV1Domain
} from '../../../shared/automation-command-domain'
import type {
  CommandRunClaimOperations,
  CommandRunClaimRequest,
  CommandRunClaimResult
} from './automation-command-claim-operations'

const MANUAL_KEY_WINDOW_MS = 24 * 60 * 60 * 1000

/** One active row and one receipt per manual key; repeated overlaps do not add runs. */
export function recordAutomationCommandOverlap(
  operations: CommandRunClaimOperations,
  domain: AutomationCommandsV1Domain,
  active: AutomationCommandClaimV1,
  request: CommandRunClaimRequest
): CommandRunClaimResult {
  const updated: AutomationCommandClaimV1 = {
    ...active,
    overlapCount: Math.min((active.overlapCount ?? 0) + 1, 1_000_000_000),
    lastOverlapAt: request.now
  }
  operations.state.automationRuns = operations.state.automationRuns.map((run) =>
    run.id === active.runId && run.commandExecution
      ? {
          ...run,
          commandExecution: { ...run.commandExecution, overlapCount: updated.overlapCount }
        }
      : run
  )
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((claim) =>
      claim.automationId === active.automationId ? updated : claim
    ),
    manualReceipts: request.manualRequest
      ? [
          ...domain.manualReceipts.filter(
            (entry) => request.now - entry.createdAt <= MANUAL_KEY_WINDOW_MS
          ),
          {
            automationId: active.automationId,
            requestKey: request.manualRequest.key,
            payloadHash: request.manualRequest.payloadHash,
            createdAt: request.manualRequest.createdAt,
            runId: active.runId,
            outcome: 'overlap' as const
          }
        ]
      : domain.manualReceipts
  }
  operations.markDomainsDirty()
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  operations.flush()
  return { kind: 'overlap', activeRunId: active.runId }
}
