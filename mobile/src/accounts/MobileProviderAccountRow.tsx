import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  type AccountsSnapshot,
  type ProviderKey,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  UsageBar
} from '../components/AccountUsage'
import {
  getAccountProviderUsage,
  getProviderAccountSelection
} from '../components/provider-account-usage'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'

export function MobileProviderAccountRow({
  snapshot,
  provider,
  accountId,
  manualSelectionBlocked,
  disabled,
  busyAccountId,
  now,
  onSelect
}: {
  snapshot: AccountsSnapshot
  provider: ProviderKey
  accountId: string | null
  manualSelectionBlocked: boolean
  disabled: boolean
  busyAccountId: string | null
  now: number
  onSelect: (provider: ProviderKey, accountId: string | null) => void
}) {
  const { accountId: selected } = getProviderAccountSelection(snapshot, provider)
  const account = snapshot[provider].accounts.find((entry) => entry.id === accountId)
  if (accountId !== null && !account) {
    return null
  }
  const isActive = selected === accountId
  const inactive =
    accountId && !isActive ? getInactiveProviderUsage(snapshot, provider, accountId) : null
  const usage = getAccountProviderUsage(snapshot, provider, accountId)
  const fetching = (isActive && usage?.status === 'fetching') || inactive?.isFetching === true
  const session = getUsageBarState(usage, 'session', fetching)
  const weekly = getUsageBarState(usage, 'weekly', fetching)
  const label = account?.email ?? 'Normal CLI login'
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={
        account
          ? `Use ${account.email} for new manual ${provider} chats`
          : `Use normal ${provider} CLI login for new manual chats`
      }
      accessibilityState={{ selected: !manualSelectionBlocked && isActive }}
      disabled={disabled || manualSelectionBlocked || isActive}
      onPress={() => onSelect(provider, accountId)}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.rowSubtitle}>
          {manualSelectionBlocked
            ? 'Automatic pool chooses accounts; save manual mode to select one here.'
            : isActive
              ? 'Default for new manual chats'
              : 'Use for new manual chats'}
        </Text>
        {accountId === null ? (
          <Text style={styles.rowSubtitle}>
            Existing CLI login on this host · outside the saved pool
          </Text>
        ) : null}
        {accountId !== null || isActive ? (
          <View style={styles.usageRow}>
            <UsageBar
              label="5h"
              usedPercent={session.usedPercent}
              unavailable={session.unavailable}
              loading={session.loading}
              resetText={getWindowResetLabel(usage, 'session', now)}
            />
            <UsageBar
              label="7d"
              usedPercent={weekly.usedPercent}
              unavailable={weekly.unavailable}
              loading={weekly.loading}
              resetText={getWindowResetLabel(usage, 'weekly', now)}
            />
          </View>
        ) : null}
        {usage?.error ? <Text style={styles.errorText}>{usage.error}</Text> : null}
      </View>
      <View style={styles.rowTrailing}>
        {!manualSelectionBlocked && isActive ? (
          <Check size={16} color={colors.accentBlue} />
        ) : busyAccountId === (accountId ?? `${provider}:default`) ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : null}
      </View>
    </Pressable>
  )
}
