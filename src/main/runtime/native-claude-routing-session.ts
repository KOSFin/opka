import type {
  NativeClaudeRoutingSelection as Selection,
  NativeClaudeRoutingOptions
} from './native-claude-routing-contract'
import { createNativeClaudeFailureAdmission } from './native-claude-failure-admission'
import { createNativeClaudeBoundarySelection } from './native-claude-boundary-selection'
import { createNativeClaudeSelectionPolicy } from './native-claude-selection-policy'
import { createNativeClaudePromptAdmission } from './native-claude-prompt-admission'
import { createNativeClaudeSelectionLease } from './native-claude-selection-lease'
import type {
  NativeClaudeHookRequest,
  NativeClaudeHookReply
} from '../../shared/native-claude-hook'
import { createClaudeNativeHookPhase } from '../claude-accounts/claude-native-hook-phase'

export function createNativeClaudeRoutingSession(options: NativeClaudeRoutingOptions) {
  const lease = createNativeClaudeSelectionLease(options)
  const cancellation = new AbortController()
  const scoped = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([cancellation.signal, signal]) : cancellation.signal
  let closed = false
  let serial = Promise.resolve()
  const { policyKey } = createNativeClaudeSelectionPolicy(options)
  const dropPending = lease.dropPending
  const select = (excluded: ReadonlySet<string>, signal?: AbortSignal) =>
    lease.select(excluded, scoped(signal))
  const publish = async (selection: Selection, canSwitch: () => boolean) => {
    options.sources.assertAccountOwned(selection.accountId)
    if (closed || lease.pending !== selection || !canSwitch()) {
      throw new Error('Claude native publication boundary changed.')
    }
    await options.facade.publish(
      selection.access,
      () => !closed && lease.pending === selection && canSwitch()
    )
    lease.adopt(selection)
    coordinator.markAdmitted()
    lease.releaseRetired()
    options.onAccountSelected?.(selection)
  }
  const phase = createClaudeNativeHookPhase({
    readOwner: () => options.readOwner()?.identity ?? null,
    readPolicy: policyKey,
    readBoundary: options.readBoundary,
    readCompletedSuccessfully: options.readCompletedSuccessfully,
    select: async (excluded) => {
      const selected = await select(excluded)
      return { accountId: selected.accountId, snapshot: selected }
    },
    publish
  })
  const admitFailure = createNativeClaudeFailureAdmission({
    confirm: options.confirmQuotaFailure,
    readBoundary: options.readBoundary,
    readAccountId: () => lease.accountId,
    prepare: phase.failure,
    onRefused: dropPending
  })
  const promptAdmission = createNativeClaudePromptAdmission({
    phase,
    onNewInput: dropPending
  })
  const coordinator = createNativeClaudeBoundarySelection({
    ...options,
    lease,
    isClosed: () => closed,
    readInputVersion: () => promptAdmission.version(),
    select,
    publish,
    stageManual: (id, signal) => lease.stageManual(id, scoped(signal)),
    enqueue: (run) => {
      const operation = serial.then(run)
      serial = operation.then(
        () => undefined,
        () => undefined
      )
      return operation
    }
  })
  const handle = async (
    request: NativeClaudeHookRequest,
    signal?: AbortSignal
  ): Promise<NativeClaudeHookReply> => {
    options.sources.assertOwned()
    const owner = options.readOwner()
    if (closed || !owner || owner.sessionId !== request.sessionId || signal?.aborted) {
      throw new Error('Claude native session ownership is unavailable.')
    }
    if (request.event === 'fresh-wake') {
      const wake = await phase.freshWake(request.wakeMarker ?? '', signal)
      return wake ? { action: 'wake', marker: wake.marker } : { action: 'none' }
    }
    if (request.event === 'claim-wake') {
      const wake = phase.claimWake(request.phaseId, request.step)
      return wake ? { action: 'wake', marker: wake.marker } : { action: 'none' }
    }
    if (request.event === 'prompt') {
      const marker = options.managedCoverage
        ? promptAdmission.consumeMarker(request.wakeMarker)
        : request.wakeMarker
      if (!marker && !options.managedCoverage) {
        promptAdmission.observeLegacyInput()
      }
      const action = await phase.prompt(
        request.promptId,
        marker ?? '',
        () => !signal?.aborted && !closed && options.readOwner()?.identity === owner.identity,
        options.managedCoverage
      )
      return { action }
    }
    if (request.event === 'failure') {
      return admitFailure(request, scoped(signal))
    }
    phase.completed()
    await coordinator.applyAtBoundary(options.readBoundary(), signal)
    return { action: 'allow' }
  }
  return {
    observeAnswerComplete: () => phase.completed(),
    ownedWakeSubmission: promptAdmission.ownedWakeSubmission,
    observePrompt: promptAdmission.observePrompt,
    accountId: () => lease.accountId,
    usesAccount: (id: string) => lease.accountId === id || lease.pending?.accountId === id,
    assignment: () => ({ accountId: lease.accountId, ownerKey: lease.ownerKey }),
    applyIdlePolicy: coordinator.applyIdlePolicy,
    handle: (request: NativeClaudeHookRequest, signal?: AbortSignal) => {
      // The fresh-wake waiter must run beside the blocking publication hook.
      if (request.event === 'fresh-wake' || (request.event === 'prompt' && !request.wakeMarker)) {
        return handle(request, signal)
      }
      const operation = serial.then(() => handle(request, signal))
      serial = operation.then(
        () => undefined,
        () => undefined
      )
      return operation
    },
    dispose: async (shutdown: { releaseCurrent?: boolean } = {}) => {
      closed = true
      cancellation.abort()
      phase.dispose()
      await serial
      lease.dispose(shutdown.releaseCurrent !== false)
    }
  }
}
