import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionTurnCompletionSubscriber } from './structured-agent-session-turn-completion-feed'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { NativeAccountRotationBoundary } from './structured-account-acquisition'
import { StructuredAgentSessionResidentBudget } from './structured-agent-session-resident-budget'

export function createStructuredResidentBudget(host: {
  context: () => {
    deps: {
      store: Pick<AgentSessionRecordStore, 'getRecord'>
      logger: Pick<StructuredAgentSessionLifetimeContext['deps']['logger'], 'warn'>
    }
  }
  sessions: ReadonlyMap<
    string,
    {
      child: Pick<StructuredAgentSessionProviderChild, 'fence' | 'phase' | 'close'> | null
      operationalRevision?: number
    }
  > & { lastActivityAt: (id: string) => number | undefined }
  serialize: <T>(id: string, task: () => Promise<T>) => Promise<T>
  hasReaders: (id: string) => boolean
  readBoundary: (id: string) => NativeAccountRotationBoundary
  hasOpenWork: (id: string) => boolean
  rest: (id: string) => Promise<void>
  isDisposed: () => boolean
}) {
  return new StructuredAgentSessionResidentBudget({
    serialize: host.serialize,
    rest: host.rest,
    stillResident: (row) => host.sessions.get(row.sessionId)?.child === row.child,
    failed: (error) =>
      host.context().deps.logger.warn('inactive native backend rest failed', {
        scope: 'resident-budget',
        error
      }),
    candidates: () => {
      if (host.isDisposed()) {
        return []
      }
      return [...host.sessions].flatMap(([sessionId, session]) => {
        const child = session.child
        const record = host.context().deps.store.getRecord(sessionId)
        if (
          !child ||
          child.phase === 'starting' ||
          !record ||
          (record.provider !== 'codex' && record.provider !== 'claude') ||
          record.lease.claimStatus !== 'live' ||
          record.lease.runtimeFence !== child.fence ||
          !record.providerHandleChain.length ||
          host.hasReaders(sessionId) ||
          host.hasOpenWork(sessionId)
        ) {
          return []
        }
        const boundary = host.readBoundary(sessionId)
        const alreadyResting = child.close?.cause === 'evict'
        if (
          (!boundary.canRest && !alreadyResting) ||
          !boundary.childrenSettled ||
          !boundary.lastCompletedTurn ||
          (child.close && !alreadyResting)
        ) {
          return []
        }
        return [
          {
            sessionId,
            child,
            revision: session.operationalRevision,
            assertCurrent: boundary.assertCurrent,
            lastActivityAt: host.sessions.lastActivityAt(sessionId) ?? 0
          }
        ]
      })
    }
  })
}

export type StructuredResidentViews = {
  hasReaders: (id: string) => boolean
  readBoundary: (id: string) => NativeAccountRotationBoundary
  subscribeCompletions: (subscriber: StructuredAgentSessionTurnCompletionSubscriber) => () => void
  track: (operation: Promise<void>) => Promise<void>
}
export function structuredResidentHostViews(
  delivery: StructuredAgentSessionClientDelivery,
  tasks: StructuredAgentSessionTaskQueue
): StructuredResidentViews {
  return {
    hasReaders: (id) => delivery.subscribers.hasReaders(id),
    readBoundary: delivery.readAccountRotationBoundary,
    subscribeCompletions: delivery.subscribeTurnCompletions,
    track: (operation) => tasks.trackAttach(operation)
  }
}
export function installStructuredResidentBudget(
  host: Parameters<typeof createStructuredResidentBudget>[0] & StructuredResidentViews
) {
  const budget = createStructuredResidentBudget(host)
  const tick = () => host.track(budget.tick())
  const unsubscribe = host.subscribeCompletions({
    id: 'inactive-resident-budget',
    emit: (event) => {
      if (event.type === 'completion') {
        void tick()
      }
    }
  })
  return {
    tick,
    dispose: () => {
      budget.dispose()
      unsubscribe()
    }
  }
}
