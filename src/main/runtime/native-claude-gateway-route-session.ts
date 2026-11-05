import { createNativeClaudeBoundarySelection } from './native-claude-boundary-selection'
import type {
  NativeClaudeRoutingBoundary,
  NativeClaudeRoutingSelection
} from './native-claude-routing-contract'
import type { ClaudeNativeGatewayRoute } from '../claude-accounts/claude-native-gateway-route'
import {
  createNativeClaudeSelectionLease,
  type NativeClaudeSelectionLeaseOptions
} from './native-claude-selection-lease'

export type NativeClaudeGatewayRouteSessionOptions = NativeClaudeSelectionLeaseOptions & {
  readManualAccountId?: () => string | null
  readBoundary?: () => NativeClaudeRoutingBoundary
  readIdleBoundary?: () => NativeClaudeRoutingBoundary
  readInputVersion?: () => unknown
  isCurrent: () => boolean
  /** Actual HTTP barrier plus fresh canonical nonrequest inventory, supplied by the host. */
  canReplace: () => boolean
  onAccountSelected?: (selection: NativeClaudeRoutingSelection) => void
}

/** Uses the same launch selection lease as direct routing; never publishes native credentials. */
export function createNativeClaudeGatewayRouteSession(
  options: NativeClaudeGatewayRouteSessionOptions
) {
  const lease = createNativeClaudeSelectionLease(options)
  const cancellation = new AbortController()
  let closed = false,
    serial = Promise.resolve()
  const scoped = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal
  const enqueue = (run: () => Promise<boolean>) => {
    const operation = serial.then(run)
    serial = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
  const authority = () => {
    lease.assertOpen()
    if (closed || !options.isCurrent()) {
      throw new Error('Claude native gateway ownership changed.')
    }
    const owner = options.readOwner()
    if (!owner) {
      throw new Error('Claude native gateway ownership changed.')
    }
    return owner.identity
  }
  const adopt = (selection: NativeClaudeRoutingSelection, stamp: string) => {
    lease.adopt(selection)
    coordinator.markAdmitted(stamp)
    try {
      lease.releaseRetired()
    } catch {
      lease.retainAmbiguous()
    }
    try {
      options.onAccountSelected?.(selection)
    } catch {
      // A presentation callback cannot undo accepted provider work or change its reply.
    }
  }
  const coordinator = createNativeClaudeBoundarySelection({
    ...options,
    lease,
    isClosed: () => closed || lease.ambiguous || !options.isCurrent(),
    readInputVersion: options.readInputVersion ?? (() => 0),
    select: (excluded, signal) => lease.select(excluded, scoped(signal)),
    stageManual: (id, signal) => lease.stageManual(id, scoped(signal)),
    publish: async (selection, canSwitch) => {
      authority()
      if (!canSwitch() || lease.pending !== selection) {
        throw new Error('Claude native gateway publication boundary changed.')
      }
      adopt(selection, coordinator.selectionStamp())
    },
    enqueue
  })
  const policyStamp = coordinator.selectionStamp
  const route = (
    selection: NativeClaudeRoutingSelection,
    owner: string,
    stamp: string,
    replacement: boolean
  ): ClaudeNativeGatewayRoute => {
    const candidate = options
      .readCandidates()
      .find((entry) => entry.accountId === selection.accountId)
    if (!candidate?.quotaIdentity) {
      if (replacement) {
        lease.dropPending()
      }
      throw new Error('Claude native gateway account identity is unavailable.')
    }
    let sent = false,
      adopted = !replacement,
      finished = false,
      admittedStamp = stamp
    const checkOwner = () => {
      if (authority() !== owner) {
        throw new Error('Claude native gateway ownership changed.')
      }
      options.sources.assertAccountOwned(selection.accountId)
      if (
        options.readCandidates().find((entry) => entry.accountId === selection.accountId)
          ?.quotaIdentity !== candidate.quotaIdentity
      ) {
        throw new Error('Claude native gateway account identity changed.')
      }
      if (
        replacement && !adopted
          ? lease.pending !== selection
          : lease.accountId !== selection.accountId || lease.ownerKey !== selection.ownerKey
      ) {
        throw new Error('Claude native gateway account selection changed.')
      }
    }
    return {
      accountId: selection.accountId,
      quotaIdentity: candidate.quotaIdentity,
      accountUuid: selection.access.identity.accountUuid,
      accessToken: selection.access.access.accessToken,
      beforeSend() {
        if (finished || sent) {
          throw new Error('Claude native gateway request admission changed.')
        }
        checkOwner()
        if (replacement && (policyStamp() !== stamp || !options.canReplace())) {
          throw new Error('Claude native gateway replacement boundary changed.')
        }
        admittedStamp = policyStamp()
        sent = true
      },
      accepted() {
        if (finished || !sent) {
          throw new Error('Claude native gateway request admission changed.')
        }
        if (adopted) {
          checkOwner()
          return
        }
        try {
          checkOwner()
          // Only beforeSend checks policy: an accepted POST retains its admitted snapshot.
          adopt(selection, admittedStamp)
          adopted = true
        } catch (error) {
          lease.retainAmbiguous()
          throw error
        }
      },
      finish(verdict) {
        if (finished) {
          return
        }
        finished = true
        if (verdict === 'unverifiable' || (verdict === 'accepted' && !adopted)) {
          lease.retainAmbiguous()
          return
        }
        if (replacement && !adopted) {
          if (lease.pending !== selection) {
            lease.retainAmbiguous()
            return
          }
          lease.dropPending()
        }
      }
    }
  }
  return {
    get accountId() {
      return lease.accountId
    },
    get ownerKey() {
      return lease.ownerKey
    },
    get ambiguous() {
      return lease.ambiguous
    },
    usesAccount: (id: string) => lease.accountId === id || lease.pending?.accountId === id,
    assignment: () => ({ accountId: lease.accountId, ownerKey: lease.ownerKey }),
    applyIdlePolicy: (signal?: AbortSignal) => coordinator.applyIdlePolicy(scoped(signal)),
    applyAtBoundary: (boundary: NativeClaudeRoutingBoundary, signal?: AbortSignal) =>
      enqueue(() => coordinator.applyAtBoundary(boundary, scoped(signal))),
    async prepareCurrent(signal: AbortSignal) {
      signal.throwIfAborted()
      const owner = authority()
      const selection = await lease.refreshCurrent(scoped(signal))
      if (authority() !== owner || signal.aborted) {
        throw new Error('Claude native gateway ownership changed.')
      }
      return route(selection, owner, policyStamp(), false)
    },
    async prepareReplacement(excluded: ReadonlySet<string>, signal: AbortSignal) {
      signal.throwIfAborted()
      const owner = authority(),
        stamp = policyStamp(),
        policy = options.readPolicy()
      if (
        !policy ||
        policy.provider !== 'claude' ||
        policy.strategy === 'manual' ||
        policy.rotation === 'off' ||
        !options.canReplace()
      ) {
        return null
      }
      const excludedAccounts = new Set(
        options
          .readCandidates()
          .filter((candidate) => excluded.has(candidate.quotaIdentity))
          .map((candidate) => candidate.accountId)
      )
      const selection = await lease.select(excludedAccounts, scoped(signal))
      if (
        signal.aborted ||
        authority() !== owner ||
        policyStamp() !== stamp ||
        !options.canReplace()
      ) {
        lease.dropPending()
        throw new Error('Claude native gateway replacement boundary changed.')
      }
      return route(selection, owner, stamp, true)
    },
    async dispose(options: { releaseCurrent?: boolean } = {}) {
      closed = true
      cancellation.abort()
      await serial
      if (options.releaseCurrent !== true) {
        lease.retainAmbiguous()
      }
      lease.dispose(options.releaseCurrent === true)
    }
  }
}
