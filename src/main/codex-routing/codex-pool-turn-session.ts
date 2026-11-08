import type { CodexTranscriptReadBudget } from '../../shared/codex-rollout-jsonl-cursor'
import type { NativeAccountPoolScope } from '../runtime/orchestration/db/account-pool-native-fences'
import { randomUUID } from 'node:crypto'
import type { AccountPoolCandidate, AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { CodexRequestTurnIdentity } from './codex-request-turn-identity'
import { CodexNativeAffinityCapacityError } from './codex-native-affinity-capacity-error'
import { CodexTurnBoundaryError } from './codex-turn-boundary-error'
import { replaceCodexRejectedRequest, type CodexPoolBinding } from './codex-pool-rejected-request'
import type { CodexQuotaReplacementRequest } from './codex-host-quota-retry'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { acquireAccountPoolAssignmentInTransaction } from '../runtime/orchestration/db/account-pool-assignments'
import {
  isAccountPoolMemberHealthy,
  selectAccountPoolRotationMember
} from '../runtime/account-pool-rotation-policy'

export type CodexPoolSelectionState = {
  policy?: AccountPoolPolicy
  candidates: AccountPoolCandidate[]
  manualAccountId: string | null
}
type Binding = CodexPoolBinding

/** A native turn may span several model requests, tools and internal child threads. */
export function createCodexPoolTurnSession(args: {
  db: OrchestrationDb
  readState: () => CodexPoolSelectionState
  /** The execution host must prove tools and children have settled; headers alone cannot. */
  canSwitch: () => boolean
  onRootThreadBound?: (
    threadId: string | null,
    context?: { settledPrevious: boolean; previousTurn?: { threadId: string; turnId: string } }
  ) => void
  areRetainedTurnsSettled?: (
    turns: readonly { threadId: string; turnId: string }[],
    budget?: CodexTranscriptReadBudget,
    nextTurn?: { threadId: string; turnId: string }
  ) => boolean
  canReplaceRejectedRequest?: (budget?: CodexTranscriptReadBudget) => boolean
  onBoundaryAccepted?: () => void
  readBoundary?: (nextTurn?: { threadId: string; turnId: string }) => {
    canSwitch: () => boolean
    onBoundaryAccepted: () => void
  }
  initialAssignment?: { ownerKey: string; assertCurrent: () => void }
  ownerPrefix: string
  assignmentScope?: NativeAccountPoolScope
}) {
  let binding: Binding | undefined
  let turn: CodexRequestTurnIdentity | undefined
  let activeRequests = 0
  let closed = false
  let ownerTreeExited = false
  let revoked = false
  let accountChanged = false
  let initialAssignment = args.initialAssignment
  let rootThreadId: string | null | undefined
  const affinities = new Map<string, { threadId: string; turnId: string }>()
  const key = (identity: { threadId: string; turnId: string }) =>
    `${identity.threadId}\0${identity.turnId}`
  const oldTurnsSettled = (
    budget?: CodexTranscriptReadBudget,
    nextTurn?: { threadId: string; turnId: string }
  ) => {
    const older = [...affinities.values()].filter((entry) => !turn || key(entry) !== key(turn))
    return older.length === 0 || args.areRetainedTurnsSettled?.(older, budget, nextTurn) === true
  }

  const releaseAssignment = () => {
    if (binding?.assignment) {
      args.db.releaseAccountPoolAssignment(binding.assignment.ownerKey)
    }
    if (closed && (ownerTreeExited || revoked) && activeRequests === 0) {
      args.assignmentScope?.close()
    }
  }
  const isSameTurn = (next: CodexRequestTurnIdentity) =>
    turn &&
    ((next.threadId === turn.threadId && next.turnId === turn.turnId) ||
      (next.parentThreadId !== undefined && next.rootTurnId === turn.turnId))

  function select(state: CodexPoolSelectionState): Binding {
    const policy =
      state.policy?.applyToNewWork && state.policy.strategy !== 'manual' ? state.policy : undefined
    if (policy && policy.provider !== 'codex') {
      throw new Error('A Codex routing session cannot use another provider account pool')
    }
    if (!policy) {
      releaseAssignment()
      const accountId = binding ? binding.accountId : state.manualAccountId
      return {
        accountId,
        quotaIdentity: state.candidates.find((candidate) => candidate.accountId === accountId)
          ?.quotaIdentity
      }
    }
    if (
      binding?.policy?.id === policy.id &&
      policy.rotation === 'off' &&
      policy.strategy !== 'quota-equalize'
    ) {
      return { ...binding, policy: structuredClone(policy) }
    }
    if (
      binding?.policy?.id === policy.id &&
      binding.policy.revision === policy.revision &&
      binding.assignment?.quotaIdentity ===
        state.candidates.find((candidate) => candidate.accountId === binding?.accountId)
          ?.quotaIdentity &&
      policy.rotation === 'on-limit' &&
      policy.strategy !== 'quota-equalize' &&
      binding.accountId !== null &&
      isAccountPoolMemberHealthy(policy, state.candidates, binding.accountId)
    ) {
      return binding
    }
    const db = args.db.db
    db.exec('BEGIN IMMEDIATE')
    try {
      initialAssignment?.assertCurrent()
      if (initialAssignment) {
        args.db.releaseAccountPoolAssignment(initialAssignment.ownerKey)
      }
      releaseAssignment()
      const rotate =
        binding?.accountId &&
        binding.policy?.id === policy.id &&
        binding.policy.revision === policy.revision
          ? selectAccountPoolRotationMember(
              db,
              { policy, candidates: state.candidates },
              binding.accountId
            )
          : undefined
      const assignment = acquireAccountPoolAssignmentInTransaction(db, {
        ownerKey: args.assignmentScope?.nextOwnerKey() ?? `${args.ownerPrefix}:${randomUUID()}`,
        policy: rotate
          ? { ...policy, members: policy.members.filter((entry) => entry.accountId === rotate.id) }
          : policy,
        candidates: state.candidates
      })
      db.exec('COMMIT')
      initialAssignment = undefined
      return { accountId: assignment.accountId, policy: structuredClone(policy), assignment }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    get accountId() {
      return binding?.accountId ?? null
    },
    get activeRequests() {
      return activeRequests
    },
    begin(identity?: CodexRequestTurnIdentity) {
      if (closed) {
        throw new Error('This native routing session is closed')
      }
      if (rootThreadId === undefined && !identity?.auxiliary) {
        rootThreadId = identity && !identity.parentThreadId ? identity.threadId : null
        args.onRootThreadBound?.(rootThreadId)
      }
      if (
        turn &&
        identity?.parentThreadId &&
        ((identity.rootTurnId !== undefined &&
          ![...affinities.values()].some((entry) => entry.turnId === identity.rootTurnId)) ||
          (accountChanged && identity.rootTurnId === undefined))
      ) {
        throw new CodexTurnBoundaryError()
      }
      const freshTurn = Boolean(
        turn && identity && !identity.auxiliary && !identity.parentThreadId && !isSameTurn(identity)
      )
      const boundary = freshTurn ? args.readBoundary?.(identity) : undefined
      const safe =
        freshTurn &&
        activeRequests === 0 &&
        oldTurnsSettled(undefined, identity) &&
        (boundary?.canSwitch() ?? args.canSwitch())
      if (
        freshTurn &&
        identity &&
        !safe &&
        !affinities.has(key(identity)) &&
        affinities.size >= 64
      ) {
        throw new CodexNativeAffinityCapacityError()
      }
      if (!binding || freshTurn || !turn) {
        if (!binding || safe) {
          const next = select(args.readState())
          accountChanged ||= binding !== undefined && next.accountId !== binding.accountId
          binding = next
          if (freshTurn) {
            if (boundary) {
              boundary.onBoundaryAccepted()
            } else {
              args.onBoundaryAccepted?.()
            }
            affinities.clear()
          }
        }
        if (identity && !identity.auxiliary && !identity.parentThreadId && rootThreadId) {
          const previous = turn
          turn = identity
          affinities.set(key(identity), { threadId: identity.threadId, turnId: identity.turnId })
          if (freshTurn) {
            rootThreadId = identity.threadId
            args.onRootThreadBound?.(rootThreadId, {
              settledPrevious: Boolean(safe),
              previousTurn: previous
            })
          }
        }
      }
      activeRequests += 1
      let finished = false
      return {
        accountId: binding.accountId,
        quotaIdentity: binding.assignment?.quotaIdentity ?? binding.quotaIdentity ?? null,
        policyRevision: binding.policy?.revision ?? null,
        assignmentOwnerKey: binding.assignment?.ownerKey ?? null,
        poolId: binding.policy?.id ?? null,
        finish() {
          if (!finished) {
            finished = true
            activeRequests -= 1
            if ((ownerTreeExited || revoked) && activeRequests === 0) {
              releaseAssignment()
            }
          }
        }
      }
    },
    replaceRejectedRequest(request: CodexQuotaReplacementRequest) {
      if (
        closed ||
        activeRequests !== 1 ||
        !turn ||
        !args.canReplaceRejectedRequest?.(request.evidenceBudget) ||
        !oldTurnsSettled(request.evidenceBudget, turn)
      ) {
        return null
      }
      const next = replaceCodexRejectedRequest({
        db: args.db,
        ownerPrefix: args.ownerPrefix,
        assignmentScope: args.assignmentScope,
        state: args.readState(),
        binding,
        request
      })
      if (!next) {
        return null
      }
      accountChanged ||= binding?.accountId !== next.accountId
      binding = next
      affinities.clear()
      affinities.set(key(turn), { threadId: turn.threadId, turnId: turn.turnId })
      return {
        accountId: next.accountId,
        quotaIdentity: next.assignment.quotaIdentity,
        policyRevision: next.policy.revision,
        assignmentOwnerKey: next.assignment.ownerKey,
        poolId: next.policy.id
      }
    },
    revoke() {
      closed = true
      revoked = true
      if (activeRequests === 0) {
        releaseAssignment()
      }
    },
    snapshot() {
      const state = args.readState()
      return {
        accountId: binding?.accountId ?? null,
        appliedRevision: binding?.policy?.revision ?? null,
        configuredRevision: state.policy?.revision ?? null,
        activeRequests,
        boundaryVerified: turn !== undefined,
        switchReady:
          !closed &&
          turn !== undefined &&
          activeRequests === 0 &&
          oldTurnsSettled() &&
          args.canSwitch(),
        closed
      }
    },
    close(ownerVerdict: 'exited' | 'unverifiable' = 'unverifiable') {
      closed = true
      ownerTreeExited ||= ownerVerdict === 'exited'
      if ((ownerTreeExited || revoked) && activeRequests === 0) {
        releaseAssignment()
      }
    }
  }
}
