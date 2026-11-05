import type {
  NativeClaudeRoutingBoundary as Boundary,
  NativeClaudeRoutingSelection as Selection
} from './native-claude-routing-contract'
import type {
  NativeClaudeSelectionLeaseOptions,
  createNativeClaudeSelectionLease
} from './native-claude-selection-lease'
import { createNativeClaudeSelectionPolicy } from './native-claude-selection-policy'
import { createNativeClaudeIdlePublication } from './native-claude-idle-publication'

type Lease = ReturnType<typeof createNativeClaudeSelectionLease>

/** Direct and gateway publication share the same live-policy and canonical-boundary coordinator. */
export function createNativeClaudeBoundarySelection(
  options: Pick<NativeClaudeSelectionLeaseOptions, 'readPolicy' | 'readOwner' | 'sources'> & {
    readManualAccountId?: () => string | null
    readIdleBoundary?: () => Boundary
    lease: Lease
    isClosed: () => boolean
    readInputVersion: () => unknown
    select: (excluded: ReadonlySet<string>, signal?: AbortSignal) => Promise<Selection>
    stageManual: (id: string, signal?: AbortSignal) => Promise<Selection>
    publish: (selection: Selection, canSwitch: () => boolean) => Promise<void>
    enqueue: (run: () => Promise<boolean>) => Promise<boolean>
  }
) {
  const { policy, policyKey, selectionStamp } = createNativeClaudeSelectionPolicy(options)
  let appliedStamp = selectionStamp()
  const applyAtBoundary = async (boundary: Boundary, signal?: AbortSignal): Promise<boolean> => {
    const owner = options.readOwner()
    if (options.isClosed() || !owner || !boundary.canSwitch()) {
      return false
    }
    options.sources.assertOwned()
    const before = appliedStamp
    const revision = policyKey()
    if (!revision && policy()) {
      appliedStamp = selectionStamp()
      return before !== appliedStamp
    }
    const input = options.readInputVersion()
    if (
      revision &&
      (policy()?.rotation === 'after-turn' || appliedStamp !== selectionStamp()) &&
      boundary.canSwitch()
    ) {
      try {
        const selection = await options.select(new Set(), signal)
        await options.publish(
          selection,
          () =>
            boundary.canSwitch() &&
            options.readInputVersion() === input &&
            policyKey() === revision &&
            options.readOwner()?.identity === owner.identity &&
            !signal?.aborted
        )
        boundary.onBoundaryAccepted()
      } finally {
        options.lease.dropPending()
      }
    }
    if (!revision && !policy() && options.readManualAccountId && boundary.canSwitch()) {
      const manual = options.readManualAccountId()
      const input = options.readInputVersion()
      if (manual === options.lease.accountId && appliedStamp !== selectionStamp()) {
        options.lease.releaseCurrentAssignment()
        appliedStamp = selectionStamp()
      }
      if (manual && manual !== options.lease.accountId) {
        const pending = await options.stageManual(manual, signal)
        try {
          await options.publish(
            pending,
            () =>
              boundary.canSwitch() &&
              options.readInputVersion() === input &&
              policyKey() === null &&
              options.readManualAccountId?.() === manual &&
              options.readOwner()?.identity === owner.identity &&
              !signal?.aborted
          )
          boundary.onBoundaryAccepted()
        } finally {
          options.lease.dropPending()
        }
      }
    }
    return before !== appliedStamp
  }
  const applyIdlePolicy = createNativeClaudeIdlePublication({
    canApply: () => !options.isClosed() && appliedStamp !== selectionStamp(),
    readBoundary: options.readIdleBoundary,
    apply: applyAtBoundary,
    enqueue: options.enqueue
  })
  return {
    applyAtBoundary,
    applyIdlePolicy,
    markAdmitted: (stamp = selectionStamp()) => {
      appliedStamp = stamp
    },
    selectionStamp
  }
}
