import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import {
  getUsageBarState,
  hasActiveProviderUsage,
  UsageBar,
  type AccountsSnapshot
} from '../components/AccountUsage'
import {
  getAccountProviderUsage,
  getProviderAccountSelection
} from '../components/provider-account-usage'
import type { MobileAccountsUsageIntent } from '../accounts/mobile-accounts-route'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { HostProfile } from '../transport/types'

export function MobileHomeAccountUsageCards(props: {
  items: { host: HostProfile; snapshot: AccountsSnapshot }[]
  onOpen: (hostId: string, usage?: MobileAccountsUsageIntent) => void
}) {
  if (props.items.length === 0) {
    return null
  }
  return (
    <>
      <Text style={styles.sectionHeading}>Account usage</Text>
      {props.items.map(({ host, snapshot }) => {
        return (
          <View key={host.id} style={styles.card}>
            {props.items.length > 1 ? (
              <Text style={styles.hostLabel} numberOfLines={1}>
                {host.name}
              </Text>
            ) : null}
            {(['claude', 'codex'] as const).map((provider) => {
              const accounts = snapshot[provider].accounts
              const selection = getProviderAccountSelection(snapshot, provider)
              const { accountId } = selection
              const active = accounts.find((account) => account.id === accountId) ?? null
              const limits = getAccountProviderUsage(snapshot, provider, active?.id ?? null)
              if (accounts.length === 0 && !hasActiveProviderUsage(limits)) {
                return null
              }
              const usage =
                selection.runtimeKey && (accountId === null || active)
                  ? { provider, accountId, runtimeKey: selection.runtimeKey }
                  : undefined
              const label =
                active?.email ?? (accountId === null ? 'System default' : 'Account unavailable')
              const sessionBar = getUsageBarState(limits, 'session')
              const weeklyBar = getUsageBarState(limits, 'weekly')
              return (
                <Pressable
                  key={provider}
                  style={({ pressed }) => [styles.row, pressed && styles.cardPressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${label} ${provider} usage on ${host.name}`}
                  onPress={() => props.onOpen(host.id, usage)}
                >
                  <View style={styles.icon}>
                    {provider === 'claude' ? (
                      <ClaudeIcon size={18} />
                    ) : (
                      <OpenAIIcon size={18} color={colors.textPrimary} />
                    )}
                  </View>
                  <View style={styles.info}>
                    <Text style={styles.email} numberOfLines={1}>
                      {label}
                    </Text>
                    <View style={styles.bars}>
                      <UsageBar
                        label="5h"
                        usedPercent={sessionBar.usedPercent}
                        unavailable={sessionBar.unavailable}
                        loading={sessionBar.loading}
                      />
                      <UsageBar
                        label="7d"
                        usedPercent={weeklyBar.usedPercent}
                        unavailable={weeklyBar.unavailable}
                        loading={weeklyBar.loading}
                      />
                    </View>
                  </View>
                </Pressable>
              )
            })}
            <Pressable
              style={styles.manageAccounts}
              accessibilityRole="button"
              accessibilityLabel={`Open ${host.name} account usage`}
              onPress={() => props.onOpen(host.id)}
            >
              <Text style={styles.manageAccountsText}>Manage accounts</Text>
            </Pressable>
          </View>
        )
      })}
    </>
  )
}

const styles = StyleSheet.create({
  sectionHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  cardPressed: { backgroundColor: colors.bgRaised },
  manageAccounts: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  manageAccountsText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  hostLabel: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  info: { flex: 1, minWidth: 0, gap: 2 },
  email: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  bars: { flexDirection: 'row', gap: spacing.md, marginTop: 4 }
})
