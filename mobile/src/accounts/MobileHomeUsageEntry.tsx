import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import type { AccountsSnapshot, ProviderKey } from '../components/AccountUsage'
import {
  matchingMobileAccountsUsageIntent,
  type MobileAccountsUsageRouteParams
} from './mobile-accounts-route'
import { styles } from './mobile-accounts-screen-styles'

export function MobileHomeUsageEntry({
  hostId,
  snapshot,
  usageParams,
  available,
  renderAccountRow
}: {
  hostId: string
  snapshot: AccountsSnapshot
  usageParams: MobileAccountsUsageRouteParams
  available: boolean
  renderAccountRow: (
    provider: ProviderKey,
    accountId: string | null,
    manualSelectionBlocked: boolean,
    initiallyExpanded: boolean
  ) => ReactNode
}) {
  const intent = available ? matchingMobileAccountsUsageIntent(snapshot, hostId, usageParams) : null
  return (
    <>
      {usageParams.usageProvider && !intent && available ? (
        <Text style={styles.rowSubtitle} accessibilityRole="alert">
          Account or runtime changed. Open a current account to view usage.
        </Text>
      ) : null}
      {intent ? (
        <View
          key={`home-usage:${hostId}:${intent.provider}:${intent.accountId ?? ''}:${intent.runtimeKey}`}
        >
          <Text style={styles.rowSubtitle}>Usage</Text>
          {renderAccountRow(intent.provider, intent.accountId, false, true)}
        </View>
      ) : null}
    </>
  )
}
