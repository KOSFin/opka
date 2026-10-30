import { OrchestrationError } from './orchestration/orchestration-error'
import type Database from '../sqlite/sync-database'
import type { AccountPoolCandidate, AccountPoolPolicy } from '../../shared/account-pool-policy'
import {
  selectAccountPoolMember,
  type AccountPoolAdmission
} from './orchestration/account-pool-admission'

export function isAccountPoolMemberHealthy(
  policy: AccountPoolPolicy,
  candidates: readonly AccountPoolCandidate[],
  accountId: string,
  now = Date.now()
): boolean {
  const member = policy.members.find((entry) => entry.accountId === accountId)
  const candidate = candidates.find((entry) => entry.accountId === accountId)
  return Boolean(
    member &&
    candidate &&
    member.state === 'enabled' &&
    member.role !== 'manual' &&
    (member.role !== 'reserve' || policy.allowReserve) &&
    (member.cooldownUntil ?? 0) <= now &&
    candidate.auth === 'ready' &&
    candidate.quota !== 'exhausted' &&
    (candidate.quota !== 'unknown' || policy.unknownQuota === 'allow')
  )
}

/** Rotation cannot demote a usable account merely to manufacture a different identity. */
export function selectAccountPoolRotationMember(
  db: Database.Database,
  admission: AccountPoolAdmission,
  currentAccountId: string
) {
  const { policy, candidates } = admission
  const current = policy.members.find((entry) => entry.accountId === currentAccountId)
  const healthy = isAccountPoolMemberHealthy(policy, candidates, currentAccountId)
  const currentIndex = policy.members.findIndex((entry) => entry.accountId === currentAccountId)
  const ordered =
    policy.strategy === 'sequential' && policy.rotation === 'after-turn' && currentIndex !== -1
      ? [...policy.members.slice(currentIndex + 1), ...policy.members.slice(0, currentIndex)]
      : policy.members
  const alternatives = ordered.filter((entry) => {
    if (entry.accountId === currentAccountId) {
      return false
    }
    if (!healthy || !current) {
      return true
    }
    const role = Number(entry.role === 'reserve') - Number(current.role === 'reserve')
    return role < 0 || (role === 0 && entry.priority <= current.priority)
  })
  try {
    return selectAccountPoolMember(db, {
      ...admission,
      policy: { ...policy, members: alternatives }
    })
  } catch (error) {
    if (
      !healthy ||
      !(error instanceof OrchestrationError) ||
      error.code !== 'account_pool_unavailable'
    ) {
      throw error
    }
    return selectAccountPoolMember(db, {
      ...admission,
      policy: {
        ...policy,
        members: policy.members.filter((entry) => entry.accountId === currentAccountId)
      }
    })
  }
}
