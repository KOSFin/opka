import type {
  NativeClaudeCoverageAck,
  NativeClaudeCoverageRequest,
  NativeClaudeCoverageObservation
} from '../../shared/native-claude-coverage'
import { agentHookServer } from '../agent-hooks/server'
import type { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { NativeClaudeHookRequest } from '../../shared/native-claude-hook'
import { createNativeCliTurnBoundary } from './native-cli-turn-boundary'
import type { NativeClaudeTerminalContext } from '../agent-hooks/server/server-native-claude-terminal'
import type { NativeCliTerminalOwner } from './native-cli-terminal-owner'

/** Private native hook capability is associated with the host's actual pane and canonical session. */
export function createNativeClaudeSessionBoundary(options: {
  launchId: string
  startedAt: number
  transitions: Pick<AgentTransitionDetector, 'subscribe' | 'latestRow'>
  readPhysicalOwner: () => NativeCliTerminalOwner | null
  readTerminalContext?: (owner: NativeCliTerminalOwner) => NativeClaudeTerminalContext | null
  isCurrent: () => boolean
  isEnabled?: () => boolean
  managedCoverage?: boolean
  readOwnedWakeSubmission?: () => string | undefined
  onObservedPrompt?: (
    event: Extract<NativeClaudeCoverageObservation, { kind: 'prompt' }>,
    knownTask: boolean
  ) => { drop?: true }
}) {
  let root: string | null = null
  let closed = false
  let lastAck: { generation: string; ack: NativeClaudeCoverageAck } | undefined
  const waiters = new Set<() => void>()
  const readOwner = () => {
    const pty = options.isCurrent() && !closed ? options.readPhysicalOwner() : null
    return pty && root ? { ...pty, launchId: options.launchId, sessionId: root } : null
  }
  const scope = (sessionId: string) => {
    const owner = !closed && options.isCurrent() ? options.readPhysicalOwner() : null
    return owner
      ? {
          ...owner,
          launchId: options.launchId,
          sessionId,
          startedAt: options.startedAt,
          statusEnabled: options.isEnabled?.() !== false,
          terminal: options.readTerminalContext?.(owner) ?? undefined
        }
      : null
  }
  const failureSnapshot = () => {
    const owner = readOwner()
    if (!owner || !options.managedCoverage) {
      return null
    }
    const held = agentHookServer.readNativeClaudeFailureBoundary({
      ...owner,
      startedAt: options.startedAt
    })
    return held.promptId
      ? {
          ...held,
          canSwitch: () => {
            const current = readOwner()
            return (
              options.isEnabled?.() !== false &&
              !!current &&
              current.ptyId === owner.ptyId &&
              current.incarnationId === owner.incarnationId &&
              current.sessionId === owner.sessionId &&
              held.canSwitch(options.readOwnedWakeSubmission?.())
            )
          }
        }
      : null
  }
  const boundary = createNativeCliTurnBoundary({
    provider: 'claude',
    launchStartedAt: options.startedAt,
    transitions: options.transitions,
    expectedSessionId: () => root,
    readNativeOwner: readOwner,
    readNativeChildren: (row) => {
      if (options.isEnabled?.() === false) {
        return { status: 'unverifiable' }
      }
      const owner = root ? scope(root) : null
      return options.managedCoverage &&
        (!owner || !agentHookServer.readNativeClaudeSealedStop(owner))
        ? { status: 'unverifiable' }
        : agentHookServer.readNativeClaudeChildInventory(row)
    }
  })
  const check = (request: NativeClaudeHookRequest) => {
    if (options.managedCoverage && request.event === 'failure') {
      const failure = failureSnapshot()
      return (
        request.sessionId === root && failure?.promptId === request.promptId && failure.canSwitch()
      )
    }
    if (options.managedCoverage && request.event !== 'stop' && request.event !== 'failure') {
      const owned = request.sessionId === root ? scope(request.sessionId) : null
      return !!owned && agentHookServer.readNativeClaudeCoverageAvailable(owned)
    }
    const owner = options.readPhysicalOwner(),
      row = owner && options.transitions.latestRow(owner.paneKey)
    if (
      closed ||
      !options.isCurrent() ||
      !owner ||
      !row ||
      row.agentType !== 'claude' ||
      row.connectionId !== null ||
      row.observation?.origin !== 'hook' ||
      row.observation.kind !== 'transition' ||
      row.restoredUnconfirmed ||
      row.isReplay ||
      row.providerSession?.id !== request.sessionId ||
      row.receivedAt < options.startedAt ||
      agentHookServer.readNativeClaudePromptId(row) !== request.promptId
    ) {
      return false
    }
    if (options.managedCoverage) {
      const owned = scope(request.sessionId)
      if (!owned || !agentHookServer.readNativeClaudeCoverageAvailable(owned)) {
        return false
      }
    }
    if (request.event === 'stop' || request.event === 'failure') {
      return row.mainAgent?.state === 'done' && row.claudeNativeBoundaryInventory === 'complete'
    }
    return true
  }
  const recheck = () => {
    for (const waiter of waiters) {
      waiter()
    }
  }
  return {
    recheck,
    waitForOwner: async (signal?: AbortSignal) => {
      const deadline = Date.now() + 6000
      while (!scope(root ?? 'pending')) {
        if (closed || signal?.aborted || Date.now() >= deadline) {
          throw new Error('Claude native continuity ownership is unverifiable.')
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      }
    },
    canRevokeAndDrain: () => {
      const owner = root ? scope(root) : null
      return !!owner && agentHookServer.readNativeClaudeCoverageQuiescent(owner)
    },
    readBoundary: () => failureSnapshot() ?? boundary.snapshot(),
    readIdleBoundary: () => failureSnapshot() ?? boundary.idleSnapshot(),
    observe: (request: NativeClaudeCoverageRequest) => {
      const owner = scope(request.sessionId)
      if (!owner) {
        throw new Error('Claude native continuity ownership is unverifiable.')
      }
      const event = request.observation
      const known =
        event.kind === 'prompt' &&
        !!event.taskId &&
        agentHookServer.isKnownNativeClaudeCoverageTask(owner, event.taskId)
      const result = agentHookServer.observeNativeClaudeCoverage(owner, request)
      if (
        result.replayed &&
        lastAck?.generation === request.generation &&
        lastAck.ack.sequence === request.sequence
      ) {
        return { ack: lastAck.ack, sealedStop: false }
      }
      if (root !== request.sessionId) {
        root = request.sessionId
        boundary.rootBound()
      }
      const verdict =
        !result.replayed && event.kind === 'prompt'
          ? options.onObservedPrompt?.(event, known)
          : undefined
      const ack = {
        sequence: result.sequence,
        healthy: result.healthy,
        ...(verdict?.drop ? { drop: true } : {})
      }
      lastAck = { generation: request.generation, ack }
      if (result.sealedStop) {
        boundary.refreshNativeEvidence()
      }
      recheck()
      return { ack, sealedStop: result.sealedStop }
    },
    readOwner: () => {
      const owner = readOwner()
      return owner
        ? {
            sessionId: owner.sessionId,
            identity: `${owner.launchId}:${owner.ptyId}:${owner.incarnationId}:${owner.sessionId}`
          }
        : null
    },
    readCompletedSuccessfully: () => {
      if (options.managedCoverage) {
        const owned = root ? scope(root) : null
        return !!owned && agentHookServer.readNativeClaudeAnswerComplete(owned)
      }
      const owner = readOwner(),
        row = owner && options.transitions.latestRow(owner.paneKey)
      return row?.mainAgent?.state === 'done' && row.mainAgent.outcome === 'success'
    },
    accept: async (request: NativeClaudeHookRequest, signal?: AbortSignal) => {
      if (!check(request)) {
        if (waiters.size >= 128) {
          throw new Error('Claude native hook admission is busy.')
        }
        const stopped = AbortSignal.any([
          AbortSignal.timeout(request.event === 'failure' ? 45000 : 5000),
          ...(signal ? [signal] : [])
        ])
        await new Promise<void>((resolve, reject) => {
          let release = () => {}
          const finish = (accepted: boolean) => {
            waiters.delete(wake)
            release()
            stopped.removeEventListener('abort', abort)
            if (accepted) {
              resolve()
            } else {
              reject(new Error('Claude native hook ownership is unverifiable.'))
            }
          }
          const wake = () => {
            if (check(request)) {
              finish(true)
            } else if (closed || stopped.aborted) {
              finish(false)
            }
          }
          const abort = () => finish(false)
          waiters.add(wake)
          release = options.transitions.subscribe(wake)
          stopped.addEventListener('abort', abort, { once: true })
          wake()
        })
      }
      if (signal?.aborted) {
        throw new Error('Claude native hook admission was stopped.')
      }
      if (root !== request.sessionId) {
        if (request.event !== 'prompt' || request.wakeMarker) {
          throw new Error('Claude native root session is unverifiable.')
        }
        root = request.sessionId
        boundary.rootBound()
      }
    },
    dispose: () => {
      closed = true
      boundary.dispose()
      recheck()
    }
  }
}
