import { formatWindowLabel } from '@/lib/window-label-formatter'
import {
  inactiveUsageMatchesAccount,
  usageMatchesAccount
} from '../../../../shared/usage-account-provenance'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function ProviderAccountQuota({
  provider,
  accountId,
  model
}: {
  provider: 'codex' | 'claude'
  accountId: string
  model: Pick<AccountsPaneSectionModel, 'poolUsageSnapshot' | 'codexAccounts' | 'claudeAccounts'>
}): React.JSX.Element | null {
  const state = model.poolUsageSnapshot
  if (!state) {
    return null
  }
  const roster = provider === 'codex' ? model.codexAccounts : model.claudeAccounts
  const active = state[provider]
  const activeAccountId = roster.activeAccountIdsByRuntime
    ? roster.activeAccountIdsByRuntime.host
    : roster.activeAccountId
  const inactive = (
    provider === 'codex' ? state.inactiveCodexAccounts : state.inactiveClaudeAccounts
  )?.find((entry) => entry.accountId === accountId)?.rateLimits
  const limits =
    activeAccountId === accountId && usageMatchesAccount(active, 'host', accountId)
      ? active
      : inactiveUsageMatchesAccount(inactive, 'host', accountId)
        ? inactive
        : null
  if (!limits || (!limits.session && !limits.weekly)) {
    return null
  }
  return (
    <div
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground"
      aria-label="Account limits"
    >
      {[
        { id: 'session', window: limits.session },
        { id: 'weekly', window: limits.weekly }
      ].map(({ id, window }) =>
        window ? (
          <span key={id}>
            {formatWindowLabel(window.windowMinutes)} · {window.usedPercent}% used
            {window.resetsAt ? ` · Resets ${new Date(window.resetsAt).toLocaleString()}` : ''}
          </span>
        ) : null
      )}
    </div>
  )
}
