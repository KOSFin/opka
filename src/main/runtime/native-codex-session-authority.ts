import type { CodexTranscriptReadBudget } from '../../shared/codex-rollout-jsonl-cursor'
import type { NativeCliSessionOwner } from './native-cli-turn-boundary'
import {
  NativeCodexRootInventory,
  type NativeCodexRootContext
} from './native-codex-root-inventory'
import { agentHookServer } from '../agent-hooks/server'
import type { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { NativeCodexPtyOwner } from './native-codex-routing-ownership'
import { isNativeCodexRoutingLaunch } from './native-codex-routing-ownership'

/** Owned ROOT sessions prove their terminal and descendant boundaries without borrowed child status. */
export function createNativeCodexSessionAuthority(
  runtime: { agentTransitions: Pick<AgentTransitionDetector, 'latestRow'> },
  launchId: string,
  readOwner: () => NativeCodexPtyOwner | null,
  home: string,
  readRequestsIdle: () => boolean = () => false,
  hooksEnabled: () => boolean = () => true
) {
  const inventory = new NativeCodexRootInventory({
    home,
    launchId,
    isCurrent: () => hooksEnabled() && isNativeCodexRoutingLaunch(runtime, launchId),
    register: (options) => agentHookServer.registerNativeCodexInventorySource(options)
  })
  let observedPty = readOwner() !== null
  const usesPtyProof = () => {
    observedPty ||= readOwner() !== null
    return observedPty
  }
  const current = () => {
    const rootSessionId = inventory.expectedSessionId()
    if (!hooksEnabled() || !rootSessionId || !isNativeCodexRoutingLaunch(runtime, launchId)) {
      return null
    }
    const owner = readOwner()
    const row = owner && runtime.agentTransitions.latestRow(owner.paneKey)
    return owner && row?.providerSession?.id === rootSessionId ? { owner, row } : null
  }
  return {
    bindRoot: (threadId: string | null, context?: NativeCodexRootContext) =>
      inventory.bindRoot(threadId, context),
    expectedSessionId: inventory.expectedSessionId,
    areRetainedTurnsSettled: inventory.retainedSettled,
    onRootTurnAccepted: inventory.acceptTurn,
    prepareQuotaRetry: async (signal: AbortSignal, budget?: CodexTranscriptReadBudget) => {
      if (!hooksEnabled()) {
        throw new Error('Native Codex account switching requires enabled agent status hooks.')
      }
      await inventory.prepare(signal, budget)
    },
    dispose: inventory.dispose,
    boundary: (
      nativeBoundary: { canSwitch: () => boolean; onBoundaryAccepted: () => void },
      nextTurn?: { threadId: string; turnId: string }
    ) => {
      const boundary = usesPtyProof() ? nativeBoundary : inventory.completedBoundary(nextTurn)
      return {
        canSwitch: () =>
          inventory.retainedSettled(undefined, undefined, nextTurn) &&
          (!usesPtyProof() || boundary === nativeBoundary) &&
          boundary.canSwitch(),
        onBoundaryAccepted: boundary.onBoundaryAccepted
      }
    },
    readNativeOwner: () => {
      usesPtyProof()
      const value = current()
      const rootSessionId = inventory.expectedSessionId()
      return value && rootSessionId ? { ...value.owner, launchId, sessionId: rootSessionId } : null
    },
    readNativeChildren: (
      row: Parameters<typeof agentHookServer.readNativeCodexChildInventory>[0]
    ) => agentHookServer.readNativeCodexChildInventory(row),
    readRetainedNativeBoundary: (held: NativeCliSessionOwner) => {
      const actual = readOwner()
      return (
        hooksEnabled() &&
        isNativeCodexRoutingLaunch(runtime, launchId) &&
        usesPtyProof() &&
        readRequestsIdle() &&
        held.launchId === launchId &&
        held.sessionId === inventory.expectedSessionId() &&
        actual?.paneKey === held.paneKey &&
        actual.ptyId === held.ptyId &&
        actual.incarnationId === held.incarnationId &&
        inventory.currentMainSettled()
      )
    },
    canReplaceRejectedRequest: (budget?: CodexTranscriptReadBudget) => {
      try {
        if (!inventory.retainedSettled(undefined, budget)) {
          return false
        }
        if (!usesPtyProof()) {
          return inventory.currentChildrenSettled(budget)
        }
        const value = current()
        if (!value) {
          return false
        }
        const { row } = value
        return (
          row.agentType === 'codex' &&
          row.connectionId === null &&
          row.observation?.origin === 'hook' &&
          row.observation.kind === 'transition' &&
          !row.isReplay &&
          !row.restoredUnconfirmed &&
          !row.sessionBoundary &&
          !row.interrupted &&
          !row.structuredHost &&
          !row.providerSessionOnly &&
          !row.programStatusOnly &&
          agentHookServer.readNativeCodexChildInventory(row, budget).status === 'settled'
        )
      } catch {
        return false
      }
    }
  }
}
