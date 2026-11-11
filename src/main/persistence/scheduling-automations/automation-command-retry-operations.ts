import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationCommandClaimV1 } from '../../../shared/automation-command-domain'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import {
  readFencedClaim,
  type CommandProgressFence,
  type CommandProgressOperations
} from './automation-command-progress-operations'

/** Consume the only retry while retaining the original run and lifecycle deadline. */
export function retryAutomationCommandRun(
  operations: CommandProgressOperations,
  fence: CommandProgressFence,
  now: number
): AutomationCommandClaimV1 {
  const { domain, claim, run } = readFencedClaim(operations, fence)
  const definition = domain.definitions.find((entry) => entry.id === claim.automationId)
  const intent = claim.processIntent
  const proof = intent?.exitProof
  if (
    claim.phase !== 'condition' ||
    claim.observation !== 'exited' ||
    claim.attempt !== 1 ||
    claim.agentIntent ||
    claim.cancelRequestedAt !== undefined ||
    domain.hostEpoch !== claim.hostGeneration ||
    claim.hostId !== LOCAL_EXECUTION_HOST_ID ||
    !definition ||
    definition.revision !== claim.definitionRevision ||
    definition.executionTargetType !== 'local' ||
    definition.executionTargetId !== claim.hostId ||
    definition.runContext?.hostId !== claim.hostId ||
    definition.workspaceMode !== 'existing' ||
    isWslUncPath(definition.runContext.path) ||
    definition.execution.policy.maxAttempts !== 2 ||
    !definition.execution.policy.idempotent ||
    definition.execution.agent !== null ||
    !intent?.execMayHappen ||
    !intent.childCgroupPath ||
    !intent.blockedChildPid ||
    !intent.blockedChildStartTime ||
    !proof ||
    !Number.isInteger(proof.exitCode) ||
    proof.exitCode === null ||
    proof.exitCode === 0 ||
    proof.timedOut !== false ||
    proof.error !== null ||
    !Number.isSafeInteger(now) ||
    now < proof.verifiedAt ||
    now >= claim.createdAt + definition.execution.policy.timeoutSeconds * 1000
  ) {
    throw new Error('Command retry is not authorized by the retained exit and current owner.')
  }
  const acquisitionId = randomUUID()
  const retried: AutomationCommandClaimV1 = {
    ...claim,
    acquisitionId,
    attempt: 2,
    phase: 'command',
    observation: 'unverifiable',
    processIntent: {
      backend: 'linux_cgroup_v1',
      unitName: `orca-automation-${acquisitionId}.scope`,
      childName: 'command',
      receiptDirectory: join(tmpdir(), `orca-automation-${acquisitionId}`)
    }
  }
  operations.state.automationCommandsV1 = {
    ...domain,
    activeClaims: domain.activeClaims.map((entry) =>
      entry.automationId === claim.automationId ? retried : entry
    )
  }
  operations.state.automationRuns = operations.state.automationRuns.map((entry) =>
    entry.id === run.id
      ? {
          ...run,
          commandExecution: {
            version: 1,
            phase: 'command',
            attempt: 2,
            observation: 'unverifiable',
            finalReason: null,
            ...(claim.overlapCount !== undefined ? { overlapCount: claim.overlapCount } : {})
          }
        }
      : entry
  )
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  operations.markDomainsDirty()
  operations.flush()
  return retried
}
