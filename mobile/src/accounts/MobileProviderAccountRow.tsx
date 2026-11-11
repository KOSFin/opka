import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check, ChevronDown, ChevronRight } from 'lucide-react-native'
import {
  type AccountsSnapshot,
  type ProviderKey,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  UsageBar
} from '../components/AccountUsage'
import { getCodexResetCreditSummary } from '../components/codex-reset-credit'
import {
  getAccountProviderUsage,
  getProviderAccountSelection
} from '../components/provider-account-usage'
import { colors } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

export function MobileProviderAccountRow({
  snapshot,
  provider,
  accountId,
  manualSelectionBlocked,
  disabled,
  busyAccountId,
  now,
  onSelect,
  renderResetAction,
  initiallyExpanded = false
}: {
  snapshot: AccountsSnapshot
  provider: ProviderKey
  accountId: string | null
  manualSelectionBlocked: boolean
  disabled: boolean
  busyAccountId: string | null
  now: number
  onSelect: (provider: ProviderKey, accountId: string | null) => void
  renderResetAction?: (closeThen: (action: () => void) => void) => ReactNode
  initiallyExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const afterClose = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      afterClose.current = null
    },
    []
  )
  const closeThen = (action: () => void): void => {
    afterClose.current = action
    setExpanded(false)
  }
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
  const resetSummary =
    provider === 'codex' && accountId && !isActive ? getCodexResetCreditSummary(usage, now) : null
  const selectForReset = Boolean(resetSummary && resetSummary.availableCount > 0)
  const canSelect = !isActive && (!manualSelectionBlocked || selectForReset)
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityRole="button"
        accessibilityLabel={`Show ${label} ${provider} usage`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle}>{label}</Text>
          <Text style={styles.rowSubtitle}>
            {isActive ? 'Default for new manual chats' : 'Saved account'}
          </Text>
          <View style={styles.usageRow}>
            <UsageBar
              label="5h"
              usedPercent={session.usedPercent}
              unavailable={session.unavailable}
              loading={session.loading}
            />
            <UsageBar
              label="7d"
              usedPercent={weekly.usedPercent}
              unavailable={weekly.unavailable}
              loading={weekly.loading}
            />
          </View>
        </View>
        <View style={styles.rowTrailing}>
          {busyAccountId === (accountId ?? `${provider}:default`) ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : expanded ? (
            <ChevronDown size={16} color={colors.textSecondary} />
          ) : (
            <ChevronRight size={16} color={colors.textSecondary} />
          )}
        </View>
      </Pressable>
      <BottomDrawer
        visible={expanded}
        onClose={() => setExpanded(false)}
        onAfterClose={() => {
          const action = afterClose.current
          afterClose.current = null
          action?.()
        }}
        contentScrollable
      >
        <View style={poolStyles.content}>
          <Text style={styles.rowTitle}>
            {provider === 'codex' ? 'Codex' : 'Claude'} · {label}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close account details"
            onPress={() => setExpanded(false)}
            style={poolStyles.action}
          >
            <Text style={poolStyles.actionText}>Back to accounts</Text>
          </Pressable>
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
          {usage && now - usage.updatedAt > 10 * 60_000 ? (
            <Text style={styles.rowSubtitle}>Last known quota · refresh before acting</Text>
          ) : null}
          {resetSummary ? (
            <Text style={styles.rowSubtitle}>
              {[resetSummary.availabilityLabel, resetSummary.expiryLabel]
                .filter(Boolean)
                .join(' · ')}
              {selectForReset ? ' · Select this account, then confirm the reset separately.' : ''}
            </Text>
          ) : null}
          {canSelect ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                selectForReset
                  ? `Select ${label} for reset`
                  : `Use ${label} for new manual ${provider} chats`
              }
              accessibilityState={{ disabled }}
              disabled={disabled}
              style={poolStyles.action}
              onPress={() => closeThen(() => onSelect(provider, accountId))}
            >
              <Text style={poolStyles.actionText}>
                {selectForReset ? 'Select account for reset' : 'Use for new manual chats'}
              </Text>
            </Pressable>
          ) : manualSelectionBlocked && !isActive ? (
            <Text style={styles.rowSubtitle}>
              Automatic pool chooses accounts; save manual mode to select one for new chats.
            </Text>
          ) : null}
          {isActive ? (
            <View style={styles.rowTrailing}>
              <Check size={16} color={colors.accentBlue} />
            </View>
          ) : null}
          {isActive ? renderResetAction?.(closeThen) : null}
        </View>
      </BottomDrawer>
    </View>
  )
}
