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
}): void {
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
          if (!boundary.canRest || !(await deps.shouldRest?.(record, boundary))) {
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
      pending.set(sessionId, turnId)
      check(sessionId)
    }
  })
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
