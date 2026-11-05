import {
  stopStructuredAgentSessionAgentUnderSerialize,
  type StructuredAgentSessionLifetimeContext
} from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { NativeAccountRotationBoundary } from './structured-account-acquisition'
import type { StructuredAgentSessionTurnCompletionSubscriber } from './structured-agent-session-turn-completion-feed'

export function installStructuredAccountRestingRotation(deps: {
  subscribe: (subscriber: StructuredAgentSessionTurnCompletionSubscriber) => () => void
  subscribeState?: (listener: () => void) => void
  residentSessionIds?: () => Iterable<string>
  readRecord: (sessionId: string) => AgentSessionRecord | null
  readBoundary: (sessionId: string) => NativeAccountRotationBoundary
  shouldRest?: (
    record: AgentSessionRecord,
    boundary: NativeAccountRotationBoundary
  ) => boolean | Promise<boolean>
  serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  stop: (sessionId: string) => Promise<unknown>
  track: (task: Promise<void>) => Promise<void>
  failed: (error: unknown) => void
}) {
  if (!deps.shouldRest) {
    return
  }
  const pending = new Map<string, string>()
  const inFlight = new Set<string>()
  const changedWhileChecking = new Set<string>()
  const check = (sessionId: string): void => {
    const turnId = pending.get(sessionId)
    if (!turnId) {
      return
    }
    if (inFlight.has(sessionId)) {
      changedWhileChecking.add(sessionId)
      return
    }
    inFlight.add(sessionId)
    void deps
      .track(
        deps.serialize(sessionId, async () => {
          const record = deps.readRecord(sessionId)
          const boundary = deps.readBoundary(sessionId)
          if (!record || boundary.lastCompletedTurn?.id !== turnId) {
            pending.delete(sessionId)
            return
          }
          if (!boundary.canRest) {
            return
          }
          if (!(await deps.shouldRest?.(record, boundary))) {
            if (!changedWhileChecking.has(sessionId)) {
              pending.delete(sessionId)
            }
            return
          }
          const current = deps.readRecord(sessionId)
          const latest = deps.readBoundary(sessionId)
          if (
            !current ||
            current.lease.runtimeFence !== record.lease.runtimeFence ||
            !latest.canRest ||
            latest.lastCompletedTurn?.id !== turnId
          ) {
            return
          }
          pending.delete(sessionId)
          await deps.stop(sessionId)
        })
      )
      .catch(deps.failed)
      .finally(() => {
        inFlight.delete(sessionId)
        if (changedWhileChecking.delete(sessionId)) {
          check(sessionId)
        }
      })
  }
  deps.subscribeState?.(() => {
    if (deps.residentSessionIds) {
      const residents = new Set(deps.residentSessionIds())
      for (const id of pending.keys()) {
        if (!residents.has(id)) {
          pending.delete(id)
        }
      }
      for (const id of residents) {
        const turn = deps.readBoundary(id).lastCompletedTurn
        if (turn) {
          pending.set(id, turn.id)
        }
      }
    }
    for (const id of pending.keys()) {
      check(id)
    }
  })
  deps.subscribe({
    id: 'account-pool-resting-rotation',
    emit: (event) => {
      if (event.type !== 'completion') {
        return
      }
      const { sessionId, turnId } = event.completion
      if (deps.residentSessionIds && !new Set(deps.residentSessionIds()).has(sessionId)) {
        return
      }
      pending.set(sessionId, turnId)
      check(sessionId)
    }
  })
  return { pendingCountForTests: () => pending.size }
}

export function installHostAccountRotation(
  context: StructuredAgentSessionLifetimeContext,
  delivery: StructuredAgentSessionClientDelivery,
  tasks: StructuredAgentSessionTaskQueue
): void {
  installStructuredAccountRestingRotation({
    subscribe: delivery.subscribeTurnCompletions,
    subscribeState: (listener) => {
      delivery.subscribeStatus({ id: 'account-pool-resting-rotation', emit: listener })
    },
    residentSessionIds: () =>
      [...context.sessions].flatMap(([id, session]) => (session.child ? [id] : [])),
    readRecord: context.deps.store.getRecord,
    readBoundary: delivery.readAccountRotationBoundary,
    shouldRest: context.deps.shouldRestForAccountRotation,
    serialize: (id, task) => tasks.serialize(id, task),
    stop: (id) =>
      stopStructuredAgentSessionAgentUnderSerialize(context, id, { cause: 'evict', resting: true }),
    track: (task) => tasks.trackAttach(task),
    failed: (error) =>
      context.deps.logger.warn('native account rotation failed', {
        scope: 'account-pool-rotation',
        error
      })
  })
}
