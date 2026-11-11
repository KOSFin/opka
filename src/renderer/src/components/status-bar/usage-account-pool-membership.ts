import type { AccountPoolView } from '../../../../shared/account-pool-view'

export function usageAccountPoolMembership(
  view: AccountPoolView,
  provider: 'claude' | 'codex',
  accountId: string
) {
  if (!view.accounts[provider].accounts.some((account) => account.id === accountId)) {
    return null
  }
  const policies = view.policies.filter((policy) => policy.provider === provider)
  const policy = policies.find((entry) => entry.applyToNewWork) ?? policies[0]
  if (!policy) {
    return { mode: 'off' as const, policyId: null, member: null, assignments: 0 }
  }
  const member = policy.members.find((entry) => entry.accountId === accountId) ?? null
  return {
    mode: policy.applyToNewWork ? policy.strategy : ('off' as const),
    policyId: policy.id,
    member,
    assignments: view.assignments.filter(
      (entry) => entry.provider === provider && entry.accountId === accountId
    ).length
  }
}
