import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { useCodexSwitcherController } from './use-codex-switcher-controller'
import { useUsageAccounts } from './UsageAccountsContext'
import { UsageAccountRows } from './UsageAccountRows'
import { toCodexStatusRuntimeTarget } from './status-bar-runtime-targets'

export function UsageCodexAccountRows({
  codex,
  now,
  display,
  mode,
  onManageProvider,
  inspectedRowId,
  onInspectRow
}: {
  codex: ProviderRateLimits
  now: number
  display: UsagePercentageDisplay
  mode: StatusBarUsageMode
  onManageProvider: () => void
  inspectedRowId?: string | null
  onInspectRow?: (rowId: string) => void
}): React.JSX.Element {
  const owner = useUsageAccounts()
  const { handleSelectAccount, isSwitching } = useCodexSwitcherController(codex)
  return (
    <UsageAccountRows
      provider="codex"
      now={now}
      display={display}
      mode={mode}
      onManageProvider={onManageProvider}
      inspectedRowId={inspectedRowId}
      onInspectRow={onInspectRow}
      selecting={isSwitching}
      onSelectAccount={(accountId) => {
        if (owner?.verified) {
          void handleSelectAccount(
            accountId,
            toCodexStatusRuntimeTarget(owner.rateLimits.codexTarget)
          )
        }
      }}
    />
  )
}
