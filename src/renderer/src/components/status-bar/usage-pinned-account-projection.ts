import { usageManagedAccountDisplay } from './usage-managed-account-display'
import {
  usageMatchesAccount,
  inactiveUsageMatchesAccount
} from '../../../../shared/usage-account-provenance'
import type { StatusBarAccountPin } from '../../../../shared/status-bar-account-pins'
import { VISIBLE_STATUS_BAR_ACCOUNT_PINS } from '../../../../shared/status-bar-account-pins'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import {
  buildClaudeStatusSwitchGroups,
  normalizeClaudeStatusRuntimeTarget
} from './status-bar-claude-accounts'
import {
  buildCodexStatusSwitchGroups,
  normalizeCodexStatusRuntimeTarget
} from './status-bar-codex-accounts'
import { getCodexStatusRuntimeKey, toCodexStatusRuntimeTarget } from './status-bar-runtime-targets'

export function usageAccountRuntimeKey(
  provider: 'claude' | 'codex',
  snapshot: ProviderAccountsSnapshot,
  limits: RateLimitState
): string {
  const selected = toCodexStatusRuntimeTarget(
    provider === 'codex' ? limits.codexTarget : limits.claudeTarget
  )
  return getCodexStatusRuntimeKey(
    provider === 'codex'
      ? normalizeCodexStatusRuntimeTarget(snapshot.codex, selected)
      : normalizeClaudeStatusRuntimeTarget(snapshot.claude, selected)
  )
}

export function projectUsagePinnedAccounts(
  pins: StatusBarAccountPin[],
  owner: string,
  snapshot: ProviderAccountsSnapshot | null,
  limits: RateLimitState,
  verified: boolean
): {
  visible: {
    pin: StatusBarAccountPin
    label: string
    limits: ProviderRateLimits | null
    available: boolean
  }[]
  overflow: number
} {
  const matching = pins.filter((pin) => pin.owner === owner)
  return {
    visible: matching.slice(0, VISIBLE_STATUS_BAR_ACCOUNT_PINS).map((pin) => {
      if (!snapshot || snapshot.failedProviders?.includes(pin.provider)) {
        return { pin, label: pin.label, limits: null, available: false }
      }
      const current = toCodexStatusRuntimeTarget(
        pin.provider === 'codex' ? limits.codexTarget : limits.claudeTarget
      )
      const groups =
        pin.provider === 'codex'
          ? buildCodexStatusSwitchGroups(snapshot.codex, current)
          : buildClaudeStatusSwitchGroups(snapshot.claude, current)
      const account = groups
        .find((group) => group.key === pin.runtimeKey)
        ?.targets.find((entry) => entry.id === pin.accountId)
      const currentRuntime = usageAccountRuntimeKey(pin.provider, snapshot, limits)
      const inactive =
        pin.provider === 'codex' ? limits.inactiveCodexAccounts : limits.inactiveClaudeAccounts
      const inactiveLimits = pin.accountId
        ? inactive.find((entry) => entry.accountId === pin.accountId)?.rateLimits
        : null
      const activeLimits = limits[pin.provider]
      const accountLimits =
        account?.active &&
        currentRuntime === pin.runtimeKey &&
        usageMatchesAccount(activeLimits, pin.runtimeKey, pin.accountId)
          ? activeLimits
          : account &&
              pin.accountId &&
              inactiveUsageMatchesAccount(inactiveLimits, pin.runtimeKey, pin.accountId)
            ? (inactiveLimits ?? null)
            : null
      return {
        pin,
        label:
          pin.accountId === null
            ? pin.label
            : (usageManagedAccountDisplay(pin.provider, snapshot, pin.accountId)?.label ??
              account?.label ??
              pin.label),
        limits: verified && account ? accountLimits : null,
        available: !!account
      }
    }),
    overflow: Math.max(0, matching.length - VISIBLE_STATUS_BAR_ACCOUNT_PINS)
  }
}
