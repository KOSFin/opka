import { AccountPoolPolicySchema, type AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { RuntimeStore } from './runtime-store-contract'

type PoolPolicyRuntime = { requireStore(): Pick<RuntimeStore, 'getSettings'> }

export function getAccountPoolPolicy(
  runtime: PoolPolicyRuntime,
  poolId: string
): AccountPoolPolicy {
  const saved = runtime
    .requireStore()
    .getSettings()
    .accountPools?.find((policy) => policy.id === poolId)
  if (!saved) {
    throw new Error('The account pool is not configured on this execution host')
  }
  return AccountPoolPolicySchema.parse(saved)
}
export function getDefaultAccountPool(
  runtime: PoolPolicyRuntime,
  provider: 'claude' | 'codex'
): AccountPoolPolicy | undefined {
  const policies = (runtime.requireStore().getSettings().accountPools ?? [])
    .map((policy) => AccountPoolPolicySchema.parse(policy))
    .filter((policy) => policy.provider === provider && policy.applyToNewWork)
  if (policies.length > 1) {
    throw new Error(
      'Multiple default pools are configured for this provider; choose one before launching'
    )
  }
  return policies[0]
}
