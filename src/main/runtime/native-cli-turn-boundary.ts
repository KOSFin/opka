import type { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  accountPoolCompletedMainTurnBoundary,
  accountPoolCompletedTurnBoundary
} from './account-pool-rotation-boundary'
import { readPtyAccountPoolChildren } from './pty-account-pool-child-inventory'

export type NativeCliTurnOwner = {
  paneKey: string
  ptyId: string
  incarnationId: string
  executionId: string
}
export type NativeCliSessionOwner = {
  paneKey: string
  ptyId: string
  incarnationId: string
  launchId: string
  sessionId: string
}
type Owner = NativeCliTurnOwner | NativeCliSessionOwner
const native = (owner: Owner): owner is NativeCliSessionOwner => 'launchId' in owner
type Permit = {
  version: number
  completedAt: number
  sessionId: string
  owner: Owner
  completedRow: AgentStatusIpcPayload
}
const sameOwner = (a: Owner, b: Owner) =>
  a.paneKey === b.paneKey &&
  a.ptyId === b.ptyId &&
  a.incarnationId === b.incarnationId &&
  (native(a)
    ? native(b) && a.launchId === b.launchId && a.sessionId === b.sessionId
    : !native(b) && a.executionId === b.executionId)

/** A completed hook grants one future root admission, even after UserPromptSubmit reports working. */
export function createNativeCliTurnBoundary(args: {
  provider: 'codex' | 'claude'
  launchStartedAt: number
  transitions: Pick<AgentTransitionDetector, 'subscribe' | 'latestRow'>
  readOwner?: () => NativeCliTurnOwner | null
  readNativeOwner?: () => NativeCliSessionOwner | null
  readNativeChildren?: (
    row: AgentStatusIpcPayload,
    completedRow?: AgentStatusIpcPayload
  ) =>
    | {
        status: 'settled' | 'live' | 'unverifiable'
      }
    | undefined
  readRetainedNativeBoundary?: (owner: NativeCliSessionOwner) => boolean
  expectedSessionId?: () => string | null
  readChildren?: (row: AgentStatusIpcPayload) => readonly AgentChildWorkView[] | undefined
  now?: () => number
}) {
  let permit: Permit | undefined
  let idlePermit: Permit | undefined
  let anchor: Owner | undefined
  let consumed: number | undefined
  let version = 0
  let disposed = false
  const children = args.readChildren ?? readPtyAccountPoolChildren
  const settled = (
    owner: Owner,
    row: AgentStatusIpcPayload,
    completedRow?: AgentStatusIpcPayload
  ) =>
    native(owner)
      ? args.readNativeChildren?.(row, completedRow)?.status === 'settled'
      : children(row)?.every((child) => child.membership === 'settled') === true
  const current = () => {
    const owner = args.readNativeOwner ? args.readNativeOwner() : args.readOwner?.()
    const row = owner && args.transitions.latestRow(owner.paneKey)
    const expected = args.expectedSessionId?.()
    if (owner && native(owner) && (!owner.launchId || !expected || owner.sessionId !== expected)) {
      return null
    }
    if (args.expectedSessionId && (!row || !expected || row.providerSession?.id !== expected)) {
      return null
    }
    return owner && row ? { owner, row } : null
  }
  const retained = (held: Permit): boolean => {
    if (!native(held.owner) || !args.readRetainedNativeBoundary) {
      return false
    }
    const row = args.transitions.latestRow(held.owner.paneKey)
    return (
      !!row?.providerSession?.id &&
      row.providerSession.id !== held.sessionId &&
      args.readRetainedNativeBoundary(held.owner)
    )
  }
  const matches = (held: Permit): boolean => {
    try {
      const state = current()
      if (!state || !sameOwner(state.owner, held.owner)) {
        return retained(held)
      }
      const { row } = state
      return (
        (native(held.owner) || row.executionId === held.owner.executionId) &&
        row.agentType === args.provider &&
        row.providerSession?.id === held.sessionId &&
        row.connectionId === null &&
        row.observation?.origin === 'hook' &&
        row.observation.kind === 'transition' &&
        !row.restoredUnconfirmed &&
        !row.isReplay &&
        !row.sessionBoundary &&
        !row.interrupted &&
        !row.structuredHost &&
        !row.providerSessionOnly &&
        !row.programStatusOnly &&
        !row.claudeTaskWakeupPending &&
        settled(state.owner, row, held.completedRow) &&
        !row.subagents?.some((child) => child.state !== 'idle') &&
        (row.state !== 'working' || (row.turnStartedAt ?? 0) > held.completedAt)
      )
    } catch {
      return false
    }
  }
  const observeCurrent = (paneKey: string, seeded = false) => {
    if (disposed) {
      return
    }
    try {
      const state = current()
      if (!state || (anchor && !sameOwner(state.owner, anchor))) {
        if (!permit || !retained(permit)) {
          permit = undefined
        }
        return
      }
      if (paneKey !== state.owner.paneKey) {
        return
      }
      if (seeded) {
        idlePermit = undefined
        permit = undefined
        return
      }
      if (permit && !matches(permit)) {
        permit = undefined
      }
      const common = {
        provider: args.provider,
        row: state.row,
        launchStartedAt: args.launchStartedAt,
        now: (args.now ?? Date.now)(),
        lastRotatedTurn: consumed
      }
      const completedAt = native(state.owner)
        ? settled(state.owner, state.row)
          ? accountPoolCompletedMainTurnBoundary(common)
          : null
        : accountPoolCompletedTurnBoundary({
            ...common,
            executionId: state.owner.executionId,
            children: children(state.row)
          })
      if (
        completedAt === null ||
        !state.row.providerSession ||
        permit?.completedAt === completedAt
      ) {
        return
      }
      anchor ??= { ...state.owner }
      permit = {
        version: ++version,
        completedAt,
        sessionId: state.row.providerSession.id,
        owner: { ...state.owner },
        completedRow: { ...state.row }
      }
      if (native(state.owner)) {
        idlePermit = permit
      }
    } catch {
      permit = undefined
    }
  }
  const release = args.transitions.subscribe((change) =>
    observeCurrent(change.paneKey, change.kind === 'seeded')
  )
  const snapshot = () => {
    const held = permit
    return Object.freeze({
      version: held?.version ?? null,
      canSwitch: () =>
        !disposed && held !== undefined && permit?.version === held.version && matches(held),
      onBoundaryAccepted: () => {
        if (!disposed && held !== undefined && permit?.version === held.version) {
          consumed = held.completedAt
          permit = undefined
          if (native(held.owner)) {
            anchor = undefined
          }
        }
      }
    })
  }
  const idleSnapshot = () => {
    const held = idlePermit
    return Object.freeze({
      canSwitch: () => {
        const state = current()
        return (
          !disposed &&
          !!held &&
          idlePermit?.version === held.version &&
          !!state &&
          state.row.state === 'done' &&
          state.row.mainAgent?.state === 'done' &&
          (state.row.turnCompletedAt ?? state.row.mainAgent.stateStartedAt) === held.completedAt &&
          matches(held)
        )
      },
      onBoundaryAccepted: () => {}
    })
  }
  return {
    refreshNativeEvidence: () => {
      const owner = args.readNativeOwner?.()
      if (owner) {
        observeCurrent(owner.paneKey)
      }
    },
    idleSnapshot,
    rootBound: () => {
      if (!disposed && args.readNativeOwner) {
        permit = undefined
        idlePermit = undefined
        anchor = undefined
      }
    },
    snapshot,
    canSwitch: () => snapshot().canSwitch(),
    dispose: () => {
      disposed = true
      idlePermit = undefined
      permit = undefined
      release()
    }
  }
}
