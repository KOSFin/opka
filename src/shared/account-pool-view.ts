import { z } from 'zod'
import { ACCOUNT_POOL_CAPABILITY, AccountPoolPolicySchema } from './account-pool-policy'
import type { AccountPoolPolicy } from './account-pool-policy'

const rosterSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), email: z.string() })),
  activeAccountId: z.string().nullable()
})
export const AccountPoolViewSchema = z.object({
  capability: z.literal(ACCOUNT_POOL_CAPABILITY),
  policies: z.array(AccountPoolPolicySchema),
  accounts: z.object({ claude: rosterSchema, codex: rosterSchema }),
  candidates: z.array(
    z.object({
      provider: z.enum(['claude', 'codex']),
      accountId: z.string(),
      auth: z.enum(['ready', 'unavailable']),
      quota: z.enum(['available', 'exhausted', 'unknown']),
      usedPercent: z.number().nullable()
    })
  ),
  assignments: z.array(
    z.object({
      ownerKey: z.string(),
      provider: z.enum(['claude', 'codex']),
      accountId: z.string(),
      poolId: z.string().nullable()
    })
  )
})
export type AccountPoolView = z.infer<typeof AccountPoolViewSchema>

export function accountPoolDrafts(view: AccountPoolView): AccountPoolPolicy[] {
  return (['claude', 'codex'] as const).flatMap((provider) => {
    const existing = view.policies.filter((policy) => policy.provider === provider)
    return existing.length
      ? existing
      : [
          {
            id: `${provider}-default`,
            provider,
            revision: 0,
            strategy: 'manual',
            applyToNewWork: false,
            rotation: 'off',
            unknownQuota: 'exclude',
            allowReserve: false,
            members: []
          }
        ]
  })
}

export function setPoolMembership(
  policy: AccountPoolPolicy,
  accountId: string,
  state: 'enabled' | 'draining' | 'disabled' | 'excluded'
): AccountPoolPolicy {
  const previous = policy.members.find((member) => member.accountId === accountId)
  const members = policy.members.filter((member) => member.accountId !== accountId)
  return {
    ...policy,
    members:
      state === 'excluded'
        ? members
        : [
            ...members,
            {
              accountId,
              priority: previous?.priority ?? members.length + 1,
              weight: previous?.weight ?? 1,
              maxConcurrent: previous?.maxConcurrent,
              role: previous?.role ?? 'primary',
              cooldownUntil: previous?.cooldownUntil,
              state
            }
          ]
  }
}

export function accountPoolStatus(
  view: AccountPoolView,
  policy: AccountPoolPolicy,
  accountId: string
): string {
  const candidate = view.candidates.find(
    (entry) => entry.provider === policy.provider && entry.accountId === accountId
  )
  const member = policy.members.find((entry) => entry.accountId === accountId)
  const assignments = view.assignments.filter(
    (entry) => entry.provider === policy.provider && entry.accountId === accountId
  )
  const cooldown =
    member?.cooldownUntil && member.cooldownUntil > Date.now()
      ? `Cooldown until ${new Date(member.cooldownUntil).toLocaleString()}`
      : 'No cooldown'
  const active = assignments.length ? `${assignments.length} allocated slots` : 'No allocated slots'
  return `Auth: ${candidate?.auth ?? 'unknown'} · Quota: ${candidate?.quota ?? 'unknown'} · ${cooldown} · ${active}`
}
