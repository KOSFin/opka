import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import type { AccountPoolCandidate, AccountPoolPolicy } from '../../../shared/account-pool-policy'
import { OrchestrationError } from './orchestration-error'

const StoredAccount = z.object({
  account: z.object({
    provider: z.enum(['claude', 'codex']),
    id: z.string(),
    quotaIdentity: z.string().optional()
  }),
  accountPool: z.object({ id: z.string(), revision: z.number() }).optional()
})
export function readAccountAssignments(db: Database.Database) {
  return db
    .prepare(`SELECT dispatch_id, state, start_options FROM worker_dispatches
    WHERE state IN ('starting','ready','start_unknown','stopping','stop_unknown')
    AND NOT EXISTS (SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id=worker_dispatches.dispatch_id)`)
    .all()
    .flatMap((row) => {
      try {
        const value: unknown = JSON.parse(String(row.start_options))
        const parsed = StoredAccount.safeParse(value)
        if (!parsed.success) {
          return []
        }
        return [
          {
            dispatchId: String(row.dispatch_id),
            state: String(row.state),
            provider: parsed.data.account.provider,
            accountId: parsed.data.account.id,
            quotaIdentity: parsed.data.account.quotaIdentity ?? parsed.data.account.id,
            poolId: parsed.data.accountPool?.id ?? null
          }
        ]
      } catch {
        return []
      }
    })
}

export type AccountPoolAdmission = {
  policy: AccountPoolPolicy
  candidates: AccountPoolCandidate[]
  preferredAccountId?: string
}

// Called inside the dispatch transaction: an unverifiable launch retains its slot until settled.
export function selectAccountPoolMember(db: Database.Database, admission: AccountPoolAdmission) {
  const { policy, candidates } = admission
  if (policy.strategy === 'manual') {
    throw new OrchestrationError('account_pool_manual', 'Choose a fixed account for a manual pool.')
  }
  const assignments = [
    ...db
      .prepare(
        'SELECT provider, quota_identity AS quotaIdentity, account_id AS accountId FROM account_pool_assignments WHERE released_at IS NULL'
      )
      .all(),
    ...readAccountAssignments(db).filter((entry) => !entry.poolId)
  ]
  const eligible = policy.members.flatMap((member) => {
    const candidate = candidates.find((entry) => entry.accountId === member.accountId)
    if (
      !candidate ||
      candidate.auth !== 'ready' ||
      member.state !== 'enabled' ||
      member.role === 'manual' ||
      (member.role === 'reserve' && !policy.allowReserve) ||
      (member.cooldownUntil ?? 0) > Date.now() ||
      candidate.quota === 'exhausted' ||
      (candidate.quota === 'unknown' && policy.unknownQuota === 'exclude')
    ) {
      return []
    }
    const active = assignments.filter(
      (entry) =>
        entry.provider === policy.provider &&
        (entry.quotaIdentity === candidate.quotaIdentity ||
          candidates.some(
            (known) =>
              known.accountId === entry.accountId && known.quotaIdentity === candidate.quotaIdentity
          ))
    ).length
    if (member.maxConcurrent !== undefined && active >= member.maxConcurrent) {
      return []
    }
    return [{ member, candidate, active }]
  })
  eligible.sort((a, b) => {
    const reserve = Number(a.member.role === 'reserve') - Number(b.member.role === 'reserve')
    if (reserve) {
      return reserve
    }
    const tier = a.member.priority - b.member.priority
    if (tier) {
      return tier
    }
    if (policy.strategy === 'balanced') {
      const occupancy = a.active / a.member.weight - b.active / b.member.weight
      if (occupancy) {
        return occupancy
      }
      // Unknown quota is never treated as an empty account.
      const quota = (a.candidate.usedPercent ?? 100) - (b.candidate.usedPercent ?? 100)
      if (quota) {
        return quota
      }
    }
    return policy.members.indexOf(a.member) - policy.members.indexOf(b.member)
  })
  const first = eligible[0]
  const preferred = eligible.find(
    (entry) =>
      policy.strategy === 'sequential' &&
      entry.candidate.accountId === admission.preferredAccountId &&
      entry.member.priority === first?.member.priority &&
      entry.member.role === first?.member.role
  )
  const selected = preferred ?? first
  if (!selected) {
    throw new OrchestrationError(
      'account_pool_unavailable',
      'No eligible account has a confirmed free slot in this pool.',
      { effectsApplied: false }
    )
  }
  return {
    provider: policy.provider,
    id: selected.candidate.accountId,
    quotaIdentity: selected.candidate.quotaIdentity
  }
}
