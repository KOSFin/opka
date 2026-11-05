import type { AccountPoolPolicy } from '../../shared/account-pool-policy'

export function createNativeClaudeSelectionPolicy(options: {
  readPolicy: () => AccountPoolPolicy | undefined
  readManualAccountId?: () => string | null
}) {
  const policy = () => {
    const value = options.readPolicy()
    return value?.provider === 'claude' ? value : undefined
  }
  return {
    policy,
    policyKey: () => {
      const value = policy()
      return value && value.strategy !== 'manual' && value.rotation !== 'off'
        ? `${value.id}:${value.revision}`
        : null
    },
    selectionStamp: () => {
      const saved = options.readPolicy()
      return `${saved?.id ?? 'manual'}:${saved?.revision ?? 0}:${options.readManualAccountId?.() ?? ''}`
    }
  }
}
