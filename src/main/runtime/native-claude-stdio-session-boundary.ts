import type {
  NativeClaudeCoverageRequest,
  NativeClaudeCoverageAck,
  NativeClaudeCoverageObservation
} from '../../shared/native-claude-coverage'
import { createNativeClaudeHookAdmission } from './native-claude-hook-admission'
import type { NativeClaudeHookRequest } from '../../shared/native-claude-hook'
import { agentHookServer } from '../agent-hooks/server'
import {
  waitNativeCliStdioOwner,
  readNativeCliStdioObservationOwner,
  readNativeCliStdioOwner,
  commitNativeCliStdioProviderSession,
  type NativeCliStdioOwner
} from './native-cli-stdio-owner'

const ownerApi = {
  wait: waitNativeCliStdioOwner,
  observe: readNativeCliStdioObservationOwner,
  strict: readNativeCliStdioOwner,
  commit: commitNativeCliStdioProviderSession
}
const identity = (owner: NativeCliStdioOwner) =>
  JSON.stringify([
    owner.sessionId,
    owner.subject,
    owner.fence,
    owner.process.hostId,
    owner.process.pid,
    owner.process.processStartTimeMs,
    owner.process.spawnToken
  ])

/** A raw invocation has a genuine structured lease; no terminal identity is manufactured. */
export function createNativeClaudeStdioSessionBoundary(options: {
  runtime: object
  launchId: string
  startedAt: number
  isCurrent: () => boolean
  isEnabled?: () => boolean
  managedCoverage: true
  readOwnedWakeSubmission?: () => string | undefined
  onObservedPrompt?: (
    event: Extract<NativeClaudeCoverageObservation, { kind: 'prompt' }>,
    known: boolean
  ) => { drop?: true }
  owners?: typeof ownerApi
  hooks?: typeof agentHookServer
}) {
  const owners = options.owners ?? ownerApi,
    hooks = options.hooks ?? agentHookServer
  let root: string | undefined,
    currentRoot: string | undefined,
    heldOwner: NativeCliStdioOwner | undefined
  let changedRoot = false,
    closed = false,
    committed = false,
    commitFailed = false
  let lastAck: { generation: string; ack: NativeClaudeCoverageAck } | undefined
  let consumedStop: string | undefined
  const observationOwner = () => {
    const owner =
      !closed && options.isCurrent() ? owners.observe(options.runtime, options.launchId) : null
    return owner && (!heldOwner || identity(owner) === identity(heldOwner)) ? owner : null
  }
  const scope = () => {
    const owner = observationOwner()
    return owner && root
      ? {
          kind: 'stdio' as const,
          owner,
          launchId: options.launchId,
          sessionId: root,
          startedAt: options.startedAt,
          statusEnabled: options.isEnabled?.() !== false
        }
      : null
  }
  const strict = () => {
    const owner = observationOwner(),
      current = owners.strict(options.runtime, options.launchId)
    return options.isEnabled?.() !== false &&
      !changedRoot &&
      !commitFailed &&
      committed &&
      owner &&
      current &&
      identity(owner) === identity(current)
      ? owner
      : null
  }
  const snapshot = () => {
    const owned = scope(),
      owner = strict()
    const failure = owned ? hooks.readNativeClaudeFailureBoundary(owned) : null
    const seal =
      owned &&
      hooks.readNativeClaudeStructuredLead(owned.owner.subject)?.lead.nativeCoverage?.sealedStop
    const completed = seal && `${root}:${seal.promptId}`
    const sealed =
      !!owned &&
      !!completed &&
      completed !== consumedStop &&
      hooks.readNativeClaudeSealedStop(owned)
    const key = owner && identity(owner)
    return {
      canSwitch: () => {
        const current = scope(),
          proof = strict()
        return (
          !!current &&
          !!proof &&
          key === identity(proof) &&
          current.sessionId === owned?.sessionId &&
          (failure?.promptId
            ? failure.canSwitch(options.readOwnedWakeSubmission?.())
            : sealed && completed !== consumedStop && hooks.readNativeClaudeSealedStop(current))
        )
      },
      onBoundaryAccepted: () => {
        if (failure?.promptId) {
          failure.onBoundaryAccepted()
        } else if (sealed) {
          consumedStop = completed
        }
      }
    }
  }
  const check = (request: NativeClaudeHookRequest) => {
    const owned = scope()
    if (!owned || request.launchId !== options.launchId) {
      return false
    }
    if (changedRoot || commitFailed) {
      return request.sessionId === currentRoot && request.event === 'prompt' && !request.wakeMarker
    }
    if (request.sessionId !== root) {
      return false
    }
    if (request.event === 'failure') {
      const failure = hooks.readNativeClaudeFailureBoundary(owned)
      return failure.promptId === request.promptId && snapshot().canSwitch()
    }
    if (request.event === 'stop') {
      return hooks.readNativeClaudeSealedStop(owned)
    }
    return hooks.readNativeClaudeCoverageAvailable(owned)
  }
  const admission = createNativeClaudeHookAdmission(check, () => closed)
  const recheck = admission.recheck
  return {
    recheck,
    waitForOwner: async (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      await owners.wait(options.runtime, options.launchId)
      signal?.throwIfAborted()
      if (!observationOwner()) {
        throw new Error('Claude native continuity ownership is unverifiable.')
      }
    },
    observe: async (request: NativeClaudeCoverageRequest) => {
      const owner = observationOwner()
      if (!owner || request.launchId !== options.launchId) {
        throw new Error('Claude native continuity ownership is unverifiable.')
      }
      const event = request.observation
      const genuineStart =
        event.kind === 'canonical-hook' &&
        event.hook.nativeOrigin === 'engine' &&
        event.hook.event === 'SessionStart' &&
        !event.hook.agentId &&
        event.hook.sessionId === request.sessionId
      heldOwner ??= owner
      if (genuineStart) {
        currentRoot = request.sessionId
        root ??= currentRoot
      }
      if (!root || root !== request.sessionId) {
        changedRoot ||= !!root
        recheck()
        return { ack: { sequence: request.sequence, healthy: false }, sealedStop: false }
      }
      if (
        genuineStart &&
        !committed &&
        !commitFailed &&
        owners.strict(options.runtime, options.launchId)
      ) {
        try {
          await owners.commit(options.runtime, options.launchId, root)
          committed = true
        } catch {
          commitFailed = true
        }
        if (!observationOwner()) {
          throw new Error('Claude native continuity ownership changed.')
        }
      }
      const owned = scope()
      if (!owned) {
        throw new Error('Claude native continuity ownership changed.')
      }
      const known =
        event.kind === 'prompt' &&
        !!event.taskId &&
        hooks.isKnownNativeClaudeCoverageTask(owned, event.taskId)
      const result = hooks.observeNativeClaudeCoverage(owned, request)
      if (
        result.replayed &&
        lastAck?.generation === request.generation &&
        lastAck.ack.sequence === request.sequence
      ) {
        return { ack: lastAck.ack, sealedStop: false }
      }
      const verdict =
        !result.replayed && event.kind === 'prompt'
          ? options.onObservedPrompt?.(event, known)
          : undefined
      const ack = {
        sequence: result.sequence,
        healthy: result.healthy && !commitFailed && !changedRoot,
        ...(verdict?.drop ? { drop: true } : {})
      }
      lastAck = { generation: request.generation, ack }
      recheck()
      return { ack, sealedStop: result.sealedStop && !commitFailed && !changedRoot }
    },
    isCurrentAccountOnly: (request: NativeClaudeHookRequest) =>
      (changedRoot || commitFailed) &&
      request.sessionId === currentRoot &&
      !!observationOwner() &&
      request.launchId === options.launchId &&
      request.event === 'prompt' &&
      !request.wakeMarker,
    readOwner: () => {
      const owner = observationOwner()
      return owner && currentRoot
        ? {
            sessionId: currentRoot,
            identity: `${options.launchId}:${identity(owner)}:${currentRoot}`
          }
        : null
    },
    readBoundary: snapshot,
    isSwitchOwnershipCurrent: () => strict() !== null,
    readIdleBoundary: snapshot,
    readCompletedSuccessfully: () => {
      const owned = scope()
      return !!owned && !changedRoot && !commitFailed && hooks.readNativeClaudeAnswerComplete(owned)
    },
    canRevokeAndDrain: () => {
      const owned = scope()
      return !!owned && !changedRoot && hooks.readNativeClaudeCoverageQuiescent(owned)
    },
    accept: admission.accept,
    dispose: () => {
      closed = true
      recheck()
    },
    // Only the host's separately proven group-exit path may retire this captured subject.
    retireCanonical: () => {
      if (heldOwner) {
        hooks.retireNativeClaudeStructuredHook(heldOwner.subject)
      }
    }
  }
}
