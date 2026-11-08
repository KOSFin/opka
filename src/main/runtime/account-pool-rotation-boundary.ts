import type { AccountPoolCandidate, AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'

export function rememberAccountPoolRotationTurn(
  completed: Map<string, number>,
  owner: string,
  turn: number
): void {
  completed.set(owner, turn)
  const oldest = completed.keys().next().value
  if (completed.size > 1024 && oldest !== undefined) {
    completed.delete(oldest)
  }
}

export type AccountPoolCompletedTurnBoundaryArgs = {
  provider: AccountPoolPolicy['provider']
  row: AgentStatusIpcPayload | null
  executionId: string
  children: readonly AgentChildWorkView[] | undefined
  launchStartedAt: number
  now: number
  lastRotatedTurn?: number
  lastInputAt?: number | null
}

export function accountPoolCompletedMainTurnBoundary(
  args: Omit<AccountPoolCompletedTurnBoundaryArgs, 'executionId' | 'children'>
): number | null {
  const { row } = args
  if (!row) {
    return null
  }
  // Plain CLI Stop hooks report idle without a verdict or a child-gated completion stamp.
  const completedAt = row.turnCompletedAt ?? row.mainAgent?.stateStartedAt
  if (
    row.observation?.origin !== 'hook' ||
    row.observation.kind !== 'transition' ||
    row.connectionId !== null ||
    row.restoredUnconfirmed ||
    row.isReplay ||
    row.sessionBoundary ||
    row.interrupted ||
    row.structuredHost ||
    row.providerSessionOnly ||
    row.programStatusOnly ||
    row.agentType !== args.provider ||
    row.state !== 'done' ||
    row.mainAgent?.state !== 'done' ||
    (row.mainAgent.outcome !== undefined &&
      !['success', 'failure'].includes(row.mainAgent.outcome)) ||
    !row.providerSession ||
    row.claudeTaskWakeupPending ||
    completedAt === undefined ||
    !Number.isFinite(completedAt) ||
    completedAt <= args.launchStartedAt ||
    completedAt > args.now ||
    args.now - completedAt > 60_000 ||
    completedAt === args.lastRotatedTurn ||
    (args.lastInputAt ?? args.launchStartedAt) > completedAt ||
    row.turnStartedAt === undefined ||
    row.turnStartedAt < args.launchStartedAt ||
    row.turnStartedAt > completedAt
  ) {
    return null
  }
  return row.subagents?.some((child) => child.state !== 'idle') ? null : completedAt
}

export function accountPoolCompletedTurnBoundary(
  args: AccountPoolCompletedTurnBoundaryArgs
): number | null {
  if (args.row?.executionId !== args.executionId) {
    return null
  }
  const completedAt = accountPoolCompletedMainTurnBoundary(args)
  // Missing inventory cannot prove that a parent's completed turn settled its children.
  if (
    args.children === undefined ||
    args.children.some((child) => child.membership !== 'settled')
  ) {
    return null
  }
  return completedAt
}

export function accountPoolRotationBoundary(
  args: Omit<AccountPoolCompletedTurnBoundaryArgs, 'provider'> & {
    policy: AccountPoolPolicy
    accountId: string
    candidate: AccountPoolCandidate | undefined
  }
): number | null {
  const { policy } = args
  if (
    policy.strategy === 'manual' ||
    (policy.rotation === 'off' && policy.strategy !== 'quota-equalize')
  ) {
    return null
  }
  const completedAt = accountPoolCompletedTurnBoundary({ ...args, provider: policy.provider })
  if (completedAt === null) {
    return null
  }
  if (policy.rotation === 'after-turn' || policy.strategy === 'quota-equalize') {
    return completedAt
  }
  const member = policy.members.find((entry) => entry.accountId === args.accountId)
  const mustLeave =
    !member ||
    member.state !== 'enabled' ||
    member.role === 'manual' ||
    (member.cooldownUntil ?? 0) > args.now ||
    (member.role === 'reserve' && !policy.allowReserve) ||
    args.candidate?.auth === 'unavailable' ||
    args.candidate?.quota === 'exhausted'
  return mustLeave ? completedAt : null
}
