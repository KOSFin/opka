import type { AccountPoolCandidate, AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'

export function accountPoolRotationBoundary(args: {
  policy: AccountPoolPolicy
  accountId: string
  candidate: AccountPoolCandidate | undefined
  row: AgentStatusIpcPayload | null
  executionId: string
  children: readonly AgentChildWorkView[] | undefined
  launchStartedAt: number
  now: number
  lastRotatedTurn?: number
}): number | null {
  const { policy, row } = args
  if (policy.strategy === 'manual' || policy.rotation === 'off' || !row) {
    return null
  }
  const completedAt = row.turnCompletedAt
  if (
    row.observation?.origin !== 'hook' ||
    row.observation.kind !== 'transition' ||
    row.executionId !== args.executionId ||
    row.connectionId !== null ||
    row.restoredUnconfirmed ||
    row.isReplay ||
    row.sessionBoundary ||
    row.interrupted ||
    row.structuredHost ||
    row.providerSessionOnly ||
    row.programStatusOnly ||
    row.agentType !== policy.provider ||
    row.state !== 'done' ||
    row.mainAgent?.state !== 'done' ||
    !['success', 'failure'].includes(row.mainAgent.outcome ?? '') ||
    !row.providerSession ||
    row.claudeTaskWakeupPending ||
    completedAt === undefined ||
    !Number.isFinite(completedAt) ||
    completedAt <= args.launchStartedAt ||
    completedAt > args.now ||
    args.now - completedAt > 60_000 ||
    completedAt === args.lastRotatedTurn ||
    row.turnStartedAt === undefined ||
    row.turnStartedAt < args.launchStartedAt ||
    row.turnStartedAt > completedAt
  ) {
    return null
  }
  // Missing inventory cannot prove that a parent's completed turn settled its children.
  if (
    args.children === undefined ||
    args.children.some((child) => child.membership !== 'settled') ||
    row.subagents?.some((child) => child.state !== 'idle')
  ) {
    return null
  }
  if (policy.rotation === 'after-turn') {
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
