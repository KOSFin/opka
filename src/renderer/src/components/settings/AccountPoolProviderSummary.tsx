import { translate } from '@/i18n/i18n'
import type { AccountPoolPolicy } from '../../../../shared/account-pool-policy'
import { ClaudeIcon, OpenAIIcon } from '../status-bar/icons'

export function AccountPoolProviderSummary({
  policy,
  savedAccountCount
}: {
  policy: AccountPoolPolicy
  savedAccountCount: number
}): React.JSX.Element {
  const mode =
    !policy.applyToNewWork || policy.strategy === 'manual'
      ? translate('settings.accountPools.manualSelection', 'Manual selection')
      : policy.strategy === 'sequential'
        ? translate('settings.accountPools.sequential', 'Sequential')
        : translate('settings.accountPools.balanced', 'Balanced')
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      {policy.provider === 'claude' ? <ClaudeIcon size={16} /> : <OpenAIIcon size={16} />}
      <span>{policy.provider === 'claude' ? 'Claude' : 'Codex'}</span>
      <span className="text-xs text-muted-foreground">{mode}</span>
      <span className="text-xs text-muted-foreground">
        {translate('settings.accountPools.savedCount', '{{count}} saved accounts', {
          count: savedAccountCount
        })}
      </span>
    </span>
  )
}
