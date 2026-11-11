import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import type { AccountPoolCandidate, AccountPoolPolicy } from '../../../shared/account-pool-policy'
import { OrchestrationError } from './orchestration-error'
import { rankQuotaEqualizeMembersWithReason } from '../account-pool-quota-equalize'

const AllocationSequence = z.object({ sequence: z.number() })
const PoolSlot = z.object({
  ownerKey: z.string(),
  poolId: z.string(),
  provider: z.enum(['claude', 'codex']),
  quotaIdentity: z.string(),
  accountId: z.string()
})
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
  /** Internal handoff only: keep the old lease until the new identity is published. */
  replacesOwnerKey?: string
}

// Called inside the dispatch transaction: an unverifiable launch retains its slot until settled.
export function selectAccountPoolMember(db: Database.Database, admission: AccountPoolAdmission) {
  const { policy, candidates } = admission
  if (policy.strategy === 'manual') {
    throw new OrchestrationError('account_pool_manual', 'Choose a fixed account for a manual pool.')
  }
  const pooled = db
    .prepare(
      'SELECT owner_key AS ownerKey, pool_id AS poolId, provider, quota_identity AS quotaIdentity, account_id AS accountId FROM account_pool_assignments WHERE released_at IS NULL'
    )
    .all()
    .map((row) => PoolSlot.parse(row))
  const replacement = admission.replacesOwnerKey
    ? pooled.find((entry) => entry.ownerKey === admission.replacesOwnerKey)
    : undefined
  if (
    admission.replacesOwnerKey &&
    (!replacement ||
      replacement.provider !== policy.provider ||
      replacement.poolId !== policy.id ||
      db
        .prepare('SELECT owner_key FROM account_pool_replacement_claims WHERE replaces_owner_key=?')
        .get(admission.replacesOwnerKey))
  ) {
    throw new OrchestrationError(
      'account_pool_replacement_invalid',
      'The previous account lease cannot be replaced.'
    )
  }
  const assignments = [...pooled, ...readAccountAssignments(db).filter((entry) => !entry.poolId)]
  const lastAllocation =
    policy.strategy === 'balanced' || policy.strategy === 'quota-equalize'
      ? db.prepare(
          'SELECT sequence FROM account_pool_assignments WHERE provider=? AND quota_identity=? ORDER BY sequence DESC LIMIT 1'
        )
      : null
  const exclusions = new Map<string, number>()
  const excluded = (reason: string) => {
    exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1)
    return []
  }
  const eligible = policy.members.flatMap((member) => {
    const candidate = candidates.find((entry) => entry.accountId === member.accountId)
    if (!candidate || candidate.auth !== 'ready') {
      return excluded('unavailable account')
    }
    if (member.state !== 'enabled' || member.role === 'manual') {
      return excluded('disabled or manual member')
    }
    if (member.role === 'reserve' && !policy.allowReserve) {
      return excluded('reserve off')
    }
    if ((member.cooldownUntil ?? 0) > Date.now()) {
      return excluded('cooldown')
    }
    if (candidate.quota === 'exhausted') {
      return excluded('exhausted quota')
    }
    if (candidate.quota === 'unknown' && policy.unknownQuota === 'exclude') {
      return excluded('unknown quota policy')
    }
    const usesQuota = (entry: { provider: unknown; quotaIdentity: unknown; accountId: unknown }) =>
      entry.provider === policy.provider &&
      (entry.quotaIdentity === candidate.quotaIdentity ||
        candidates.some(
          (known) =>
            known.accountId === entry.accountId && known.quotaIdentity === candidate.quotaIdentity
        ))
    const active = assignments.filter(usesQuota).length
    const retainedOwnSlot = replacement && usesQuota(replacement) ? 1 : 0
    if (member.maxConcurrent !== undefined && active - retainedOwnSlot >= member.maxConcurrent) {
      return excluded('no free slot')
    }
    const last = lastAllocation?.get(policy.provider, candidate.quotaIdentity)
    const sequence = last ? AllocationSequence.parse(last).sequence : 0
    return [{ member, candidate, active, sequence }]
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
      // Persisted recency prevents serial turns with equal quota from starving later members.
      const recency = a.sequence - b.sequence
      if (recency) {
        return recency
      }
    }
    return policy.members.indexOf(a.member) - policy.members.indexOf(b.member)
  })
  let selectionReason: string | undefined
  if (policy.strategy === 'quota-equalize') {
    for (let start = 0; start < eligible.length;) {
      let end = start + 1
      while (
        end < eligible.length &&
        eligible[end].member.role === eligible[start].member.role &&
        eligible[end].member.priority === eligible[start].member.priority
      ) {
        end += 1
      }
      const ranking = rankQuotaEqualizeMembersWithReason(
        eligible.slice(start, end).map((entry) => ({ ...entry, weight: entry.member.weight })),
        admission.preferredAccountId
      )
      if (start === 0) {
        selectionReason = ranking.reason
      }
      eligible.splice(start, end - start, ...ranking.ranked)
      start = end
    }
  }
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
    quotaIdentity: selected.candidate.quotaIdentity,
    ...(selectionReason
      ? {
          selectionReason: `Priority ${selected.member.priority} ${selected.member.role}. ${selectionReason}${exclusions.size ? ` Excluded: ${[...exclusions].map(([reason, count]) => `${reason} (${count})`).join(', ')}.` : ''}`
        }
      : {})
  }
}
