import type { Store } from '../persistence'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'

type DurableWrite<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>>

export type AutomationRunWriter = {
  createRun: DurableWrite<Store['createAutomationRun']>
  claimCommandRun: DurableWrite<Store['claimCommandAutomationRun']>
  advanceCommandRun: DurableWrite<Store['advanceCommandAutomationRun']>
  adoptCommandCondition: DurableWrite<Store['adoptProvenCommandCondition']>
  bindCommandProcessIntent: DurableWrite<Store['bindCommandAutomationProcessIntent']>
  recordCommandExitProof: DurableWrite<Store['recordCommandAutomationExitProof']>
  bindAgentProcessIntent: DurableWrite<Store['bindAutomationAgentProcessIntent']>
  recordAgentExitProof: DurableWrite<Store['recordAutomationAgentExitProof']>
  requestCommandCancel: DurableWrite<Store['requestCommandAutomationCancel']>
  settleCommandRun: DurableWrite<Store['settleCommandAutomationRun']>
  advanceCommandNextRun: DurableWrite<Store['advanceCommandAutomationNextRun']>
  updateRun: DurableWrite<Store['updateAutomationRun']>
  /** Null when nothing could be folded — the caller then writes an ordinary run. */
  repeatSkip: DurableWrite<Store['recordRepeatedAutomationSkip']>
  advanceNextRun: DurableWrite<Store['advanceAutomationNextRun']>
}

export type LegacyAutomationRunWriter = Pick<
  AutomationRunWriter,
  'createRun' | 'updateRun' | 'repeatSkip' | 'advanceNextRun'
>

/** Wraps run persistence so every committed write announces itself. Clients with
 *  the Automations page closed — or none attached at all — have no other way to
 *  learn that a run progressed, so the event must follow the write, not a render. */
export function createAutomationRunWriter(
  store: Pick<
    Store,
    | 'createAutomationRun'
    | 'claimCommandAutomationRun'
    | 'advanceCommandAutomationRun'
    | 'adoptProvenCommandCondition'
    | 'bindCommandAutomationProcessIntent'
    | 'recordCommandAutomationExitProof'
    | 'bindAutomationAgentProcessIntent'
    | 'recordAutomationAgentExitProof'
    | 'requestCommandAutomationCancel'
    | 'settleCommandAutomationRun'
    | 'releaseCommandAutomationClaim'
    | 'advanceCommandAutomationNextRun'
    | 'updateAutomationRun'
    | 'recordRepeatedAutomationSkip'
    | 'advanceAutomationNextRun'
    | 'automationChangeSelector'
    | 'flushPendingOrThrowAsync'
  >,
  publish: PublishAutomationsChanged | null
): AutomationRunWriter {
  // A run write never moves the record, so its own host is the whole publication.
  // A record that can no longer be named degrades to the authority-wide event.
  const announce = (automationId: string, reason: 'run' | 'usage'): void => {
    if (!publish) {
      return
    }
    const selector = store.automationChangeSelector(automationId)
    publish({ reason, ...(selector ? { selector } : {}) })
  }
  return {
    claimCommandRun: async (request) => {
      const result = store.claimCommandAutomationRun(request)
      // A replay can race the first caller's flush; neither may acknowledge an uncommitted claim.
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      if (result.kind === 'claimed' || result.kind === 'overlap') {
        announce(request.automationId, 'run')
      }
      return result
    },
    advanceCommandRun: async (fence, update) => {
      const run = store.advanceCommandAutomationRun(fence, update)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(run.automationId, 'run')
      return run
    },
    adoptCommandCondition: async (fence, nextHostGeneration) => {
      const claim = store.adoptProvenCommandCondition(fence, nextHostGeneration)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(claim.automationId, 'run')
      return claim
    },
    bindCommandProcessIntent: async (fence, receipt) => {
      const claim = store.bindCommandAutomationProcessIntent(fence, receipt)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(claim.automationId, 'run')
      return claim
    },
    recordCommandExitProof: async (fence, observation, verifiedAt) => {
      const claim = store.recordCommandAutomationExitProof(fence, observation, verifiedAt)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(claim.automationId, 'run')
      return claim
    },
    bindAgentProcessIntent: async (fence, receipt) => {
      const claim = store.bindAutomationAgentProcessIntent(fence, receipt)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(claim.automationId, 'run')
      return claim
    },
    recordAgentExitProof: async (fence, observation, verifiedAt) => {
      const claim = store.recordAutomationAgentExitProof(fence, observation, verifiedAt)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(claim.automationId, 'run')
      return claim
    },
    requestCommandCancel: async (fence, requestKey, now) => {
      const claim = store.requestCommandAutomationCancel(fence, requestKey, now)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(claim.automationId, 'run')
      return claim
    },
    settleCommandRun: async (fence, result) => {
      const run = store.settleCommandAutomationRun(fence, result)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      store.releaseCommandAutomationClaim(fence)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(run.automationId, 'run')
      return run
    },
    advanceCommandNextRun: async (id, now) => {
      const definition = store.advanceCommandAutomationNextRun(id, now)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return definition
    },
    advanceNextRun: async (id, now) => {
      const automation = store.advanceAutomationNextRun(id, now)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return automation
    },
    createRun: async (automation, scheduledFor, trigger): Promise<AutomationRun> => {
      const run = store.createAutomationRun(automation, scheduledFor, trigger)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(automation.id, 'run')
      return run
    },
    updateRun: async (result: AutomationDispatchResult): Promise<AutomationRun> => {
      const run = store.updateAutomationRun(result)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(run.automationId, result.usage ? 'usage' : 'run')
      return run
    },
    repeatSkip: async (automationId, error, scheduledFor): Promise<AutomationRun | null> => {
      const run = store.recordRepeatedAutomationSkip(automationId, error, scheduledFor)
      if (run) {
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        announce(automationId, 'run')
      }
      return run
    }
  }
}
