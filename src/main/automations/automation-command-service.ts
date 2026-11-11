import type { Store } from '../persistence'
import type {
  AutomationCommandClaimV1,
  AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { latestAutomationOccurrenceAtOrBefore } from '../../shared/automation-schedule-occurrences'
import type {
  CommandRunClaimRequest,
  CommandRunClaimResult
} from '../persistence/scheduling-automations/automation-command-claim-operations'
import {
  runClaimedAutomationCommand,
  type AutomationCommandRunAdapter
} from './automation-command-runner'
import type { AutomationRunWriter } from './automation-run-writer'

export type AutomationCommandHostAdapter = AutomationCommandRunAdapter & {
  isHostReady(): boolean
  provePriorCommandExit?(claim: AutomationCommandClaimV1): boolean
  supportsDefinition(definition: AutomationCommandDefinitionV1): Promise<boolean>
  cancelRun(claim: AutomationCommandClaimV1): Promise<'live' | 'unverifiable' | 'exited'>
}

type CommandServiceOptions = {
  store: Pick<
    Store,
    'listCommandAutomations' | 'listCommandAutomationClaims' | 'getCommandAutomationClaim'
  >
  runs: Pick<
    AutomationRunWriter,
    | 'claimCommandRun'
    | 'advanceCommandNextRun'
    | 'advanceCommandRun'
    | 'adoptCommandCondition'
    | 'settleCommandRun'
    | 'requestCommandCancel'
  >
  adapter: AutomationCommandHostAdapter | null
  hostGeneration: number | null
  isActive(): boolean
  runInLane<T>(id: string, operation: () => Promise<T>): Promise<T>
}

export class AutomationCommandService {
  private readonly continuingRunIds = new Set<string>()
  constructor(private readonly options: CommandServiceOptions) {}

  async reconcileRetainedCommands(): Promise<void> {
    const { adapter, store } = this.options
    if (!adapter || !this.available()) {
      return
    }
    const definitions = new Map(store.listCommandAutomations().map((entry) => [entry.id, entry]))
    for (const claim of store.listCommandAutomationClaims()) {
      if (
        !this.options.isActive() ||
        !['command', 'condition', 'report'].includes(claim.phase) ||
        claim.hostId !== LOCAL_EXECUTION_HOST_ID
      ) {
        continue
      }
      const definition = definitions.get(claim.automationId)
      if (!definition || definition.revision !== claim.definitionRevision) {
        continue
      }
      try {
        if (claim.phase === 'report') {
          this.continueRun(definition, claim, adapter)
          continue
        }
        if (!(await adapter.supportsDefinition(definition))) {
          continue
        }
        if (claim.hostGeneration === this.options.hostGeneration) {
          this.continueRun(definition, claim, adapter)
        } else if (
          claim.phase === 'condition' &&
          adapter.provePriorCommandExit?.(claim) &&
          this.options.hostGeneration
        ) {
          const adopted = await this.options.runs.adoptCommandCondition(
            {
              automationId: claim.automationId,
              runId: claim.runId,
              acquisitionId: claim.acquisitionId,
              hostGeneration: claim.hostGeneration,
              expectedPhase: 'condition'
            },
            this.options.hostGeneration
          )
          this.continueRun(definition, adopted, adapter)
        }
      } catch {
        // The retained claim still blocks a second effect.
      }
    }
  }

  available(): boolean {
    const { adapter, hostGeneration } = this.options
    return (
      adapter !== null &&
      hostGeneration !== null &&
      Number.isSafeInteger(hostGeneration) &&
      hostGeneration > 0 &&
      adapter.isHostReady()
    )
  }

  async runNow(
    request: Pick<CommandRunClaimRequest, 'automationId' | 'definitionRevision' | 'manualRequest'>
  ): Promise<CommandRunClaimResult> {
    const { adapter, hostGeneration, store, runs } = this.options
    if (!adapter || !hostGeneration || !this.available() || !this.options.isActive()) {
      throw new Error('automation_command_unsupported')
    }
    const definition = store
      .listCommandAutomations()
      .find((entry) => entry.id === request.automationId)
    if (!definition || definition.revision !== request.definitionRevision) {
      throw new Error('Command automation changed or is unavailable.')
    }
    if (!(await adapter.supportsDefinition(definition)) || !this.options.isActive()) {
      throw new Error('automation_command_unsupported')
    }
    const now = Date.now()
    const result = await this.options.runInLane(definition.id, () => {
      if (!this.options.isActive() || !this.available()) {
        throw new Error('automation_command_unsupported')
      }
      return runs.claimCommandRun({
        ...request,
        ownerHostId: LOCAL_EXECUTION_HOST_ID,
        ownerHostGeneration: hostGeneration,
        scheduledFor: now,
        trigger: 'manual',
        now
      })
    })
    if (result.kind === 'claimed' && this.options.isActive()) {
      this.continueRun(definition, result.claim, adapter)
    }
    return result
  }

  async cancel(
    automationId: string,
    runId: string,
    requestKey: string
  ): Promise<{ requested: true; observation: 'live' | 'unverifiable' | 'exited' }> {
    const { adapter, hostGeneration, store, runs } = this.options
    const claim = store.getCommandAutomationClaim(automationId, runId)
    if (!claim) {
      throw new Error('Command run acquisition changed or is unavailable.')
    }
    const persisted = await runs.requestCommandCancel(
      {
        automationId,
        runId,
        acquisitionId: claim.acquisitionId,
        hostGeneration: claim.hostGeneration,
        expectedPhase: claim.phase
      },
      requestKey,
      Date.now()
    )
    let observation: 'live' | 'unverifiable' | 'exited' = 'unverifiable'
    try {
      if (adapter && claim.hostGeneration === hostGeneration) {
        observation = await adapter.cancelRun(persisted)
      }
    } catch {
      observation = 'unverifiable'
    }
    return { requested: true, observation }
  }

  async evaluateDue(now: number): Promise<void> {
    if (!this.available()) {
      return
    }
    for (const definition of this.options.store.listCommandAutomations()) {
      if (!this.options.isActive()) {
        break
      }
      if (!definition.enabled || definition.nextRunAt > now) {
        continue
      }
      try {
        await this.evaluateOne(definition, now)
      } catch {
        // The durable claim blocks retry if admission crossed its flush boundary.
      }
    }
  }

  private async evaluateOne(definition: AutomationCommandDefinitionV1, now: number): Promise<void> {
    const { adapter, hostGeneration, runs } = this.options
    if (!adapter || !hostGeneration || !(await adapter.supportsDefinition(definition))) {
      return
    }
    const scheduledFor = latestAutomationOccurrenceAtOrBefore(
      definition.rrule,
      definition.dtstart,
      now,
      definition.timezone
    )
    if (scheduledFor === null || now - scheduledFor > definition.missedRunGraceMinutes * 60_000) {
      await runs.advanceCommandNextRun(definition.id, now)
      return
    }
    const result = await this.options.runInLane(definition.id, () => {
      if (!this.options.isActive() || !this.available()) {
        throw new Error('automation_command_unsupported')
      }
      return runs.claimCommandRun({
        automationId: definition.id,
        definitionRevision: definition.revision,
        ownerHostId: LOCAL_EXECUTION_HOST_ID,
        ownerHostGeneration: hostGeneration,
        scheduledFor,
        trigger: 'scheduled',
        now
      })
    })
    await runs.advanceCommandNextRun(definition.id, now)
    if (result.kind === 'claimed' && this.options.isActive()) {
      this.continueRun(definition, result.claim, adapter)
    }
  }

  private continueRun(
    definition: AutomationCommandDefinitionV1,
    claim: AutomationCommandClaimV1,
    adapter: AutomationCommandHostAdapter
  ): void {
    if (this.continuingRunIds.has(claim.runId)) {
      return
    }
    this.continuingRunIds.add(claim.runId)
    void runClaimedAutomationCommand({
      definition,
      claim,
      runs: this.options.runs,
      adapter
    })
      .catch(() => {
        // The durable claim stays active until the same host can prove its stage.
      })
      .finally(() => this.continuingRunIds.delete(claim.runId))
  }
}
