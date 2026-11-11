import type { AutomationRun } from '../../../shared/automations-types'
import { readAutomationCommandsV1Domain } from '../../../shared/automation-command-domain'
import {
  claimAutomationCommandRun,
  type CommandRunClaimRequest
} from '../scheduling-automations/automation-command-claim-operations'
import {
  advanceCommandAutomationNextRun,
  createCommandAutomationDefinition,
  deleteCommandAutomationDefinition,
  listCommandAutomationDefinitions,
  replaceCommandAutomationDefinition
} from '../scheduling-automations/automation-command-definition-operations'
import {
  advanceAutomationCommandRun,
  requestAutomationCommandCancel,
  releaseAutomationCommandClaim,
  settleAutomationCommandRun,
  type CommandProgressFence
} from '../scheduling-automations/automation-command-progress-operations'
import {
  bindAutomationCommandProcessIntent,
  recordAutomationCommandExitProof
} from '../scheduling-automations/automation-command-process-operations'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'

type CommandPersistenceRuntime = Pick<
  StoreRuntimeState,
  'dirtyProfileStateDomains' | 'pendingAutomationRunsAfter' | 'state'
>

const commandPersistenceContext = Symbol('AutomationCommandPersistence')

export class AutomationCommandPersistence {
  readonly [commandPersistenceContext]: {
    runtime: CommandPersistenceRuntime
    flushBarriers: WriteFlushBarrierOperations
  }

  constructor(runtime: CommandPersistenceRuntime, flushBarriers: WriteFlushBarrierOperations) {
    this[commandPersistenceContext] = { runtime, flushBarriers }
  }

  listCommandAutomations() {
    return listCommandAutomationDefinitions(this[commandPersistenceContext].runtime.state)
  }

  listCommandAutomationClaims() {
    return readAutomationCommandsV1Domain(
      this[commandPersistenceContext].runtime.state.automationCommandsV1
    ).activeClaims
  }

  getCommandAutomationManualReceipt(automationId: string, requestKey: string) {
    return (
      readAutomationCommandsV1Domain(
        this[commandPersistenceContext].runtime.state.automationCommandsV1
      ).manualReceipts.find(
        (entry) => entry.automationId === automationId && entry.requestKey === requestKey
      ) ?? null
    )
  }

  getCommandAutomationClaim(automationId: string, runId: string) {
    return (
      readAutomationCommandsV1Domain(
        this[commandPersistenceContext].runtime.state.automationCommandsV1
      ).activeClaims.find(
        (claim) => claim.automationId === automationId && claim.runId === runId
      ) ?? null
    )
  }

  createCommandAutomation(value: unknown, now?: number) {
    return createCommandAutomationDefinition(this.definitionOperations(), value, now)
  }

  replaceCommandAutomation(id: string, revision: number, value: unknown, now?: number) {
    return replaceCommandAutomationDefinition(this.definitionOperations(), id, revision, value, now)
  }

  deleteCommandAutomation(id: string, revision: number): void {
    deleteCommandAutomationDefinition(this.definitionOperations(), id, revision)
  }

  advanceCommandAutomationNextRun(id: string, now: number) {
    return advanceCommandAutomationNextRun(this.definitionOperations(), id, now)
  }

  claimCommandAutomationRun(request: CommandRunClaimRequest) {
    const runtime = this[commandPersistenceContext].runtime
    return claimAutomationCommandRun(
      {
        state: runtime.state,
        flush: () => this[commandPersistenceContext].flushBarriers.flush(),
        markDomainsDirty: () => this.markRunDomainsDirty(),
        recordAutomationRunsMutation: (runs) => {
          runtime.pendingAutomationRunsAfter = runs
        }
      },
      request
    )
  }

  advanceCommandAutomationRun(
    fence: CommandProgressFence,
    update: Parameters<typeof advanceAutomationCommandRun>[2]
  ) {
    return advanceAutomationCommandRun(this.progressOperations(), fence, update)
  }

  bindCommandAutomationProcessIntent(
    fence: CommandProgressFence,
    receipt: Parameters<typeof bindAutomationCommandProcessIntent>[2]
  ) {
    return bindAutomationCommandProcessIntent(this.progressOperations(), fence, receipt)
  }

  recordCommandAutomationExitProof(
    fence: CommandProgressFence,
    observation: Parameters<typeof recordAutomationCommandExitProof>[2],
    verifiedAt: number
  ) {
    return recordAutomationCommandExitProof(
      this.progressOperations(),
      fence,
      observation,
      verifiedAt
    )
  }

  requestCommandAutomationCancel(fence: CommandProgressFence, requestKey: string, now: number) {
    return requestAutomationCommandCancel(this.progressOperations(), fence, requestKey, now)
  }

  settleCommandAutomationRun(
    fence: CommandProgressFence,
    result: Parameters<typeof settleAutomationCommandRun>[2]
  ) {
    return settleAutomationCommandRun(this.progressOperations(), fence, result)
  }

  releaseCommandAutomationClaim(fence: CommandProgressFence): void {
    releaseAutomationCommandClaim(this.progressOperations(), fence)
  }

  private definitionOperations() {
    const { runtime, flushBarriers } = this[commandPersistenceContext]
    return {
      state: runtime.state,
      markDomainDirty: () => runtime.dirtyProfileStateDomains?.add('automationCommandsV1'),
      flush: () => flushBarriers.flush()
    }
  }

  private progressOperations() {
    const { runtime, flushBarriers } = this[commandPersistenceContext]
    return {
      state: runtime.state,
      markDomainsDirty: () => this.markRunDomainsDirty(),
      recordAutomationRunsMutation: (runs: readonly AutomationRun[]) => {
        runtime.pendingAutomationRunsAfter = runs
      },
      flush: () => flushBarriers.flush()
    }
  }

  private markRunDomainsDirty(): void {
    const runtime = this[commandPersistenceContext].runtime
    runtime.dirtyProfileStateDomains?.add('automationCommandsV1')
    runtime.dirtyProfileStateDomains?.add('automationRuns')
  }
}
