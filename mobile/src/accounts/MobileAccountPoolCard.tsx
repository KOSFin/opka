import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import type { AccountPoolView } from '../../../src/shared/account-pool-view'
import { accountPoolStatus } from '../../../src/shared/account-pool-view'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import { MobileSwitch } from '../components/MobileSwitch'
import { colors } from '../theme/mobile-theme'
import { MobileAccountPoolLaunchSettings } from './MobileAccountPoolLaunchSettings'
import { MobileAccountPoolMemberSettings } from './MobileAccountPoolMemberSettings'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'
import type { MobileAccountPresentation } from './mobile-account-presentation'
import {
  MobileNativePoolRoutingScope,
  MobileNativePoolRoutingNotice,
  MobileNativePoolConnection,
  type MobileNativePoolRoutingTarget
} from './MobileNativePoolRoutingScope'

export function MobileAccountPoolCard({
  policy,
  view,
  disabled,
  dirty,
  onDiscard,
  onChange,
  onPick,
  onSave,
  routingTarget,
  presentation
}: {
  policy: AccountPoolPolicy
  view: AccountPoolView
  dirty: boolean
  onDiscard: () => void
  disabled: boolean
  onChange: (policy: AccountPoolPolicy) => void
  onPick: (accountId?: string) => void
  onSave: () => void
  routingTarget?: MobileNativePoolRoutingTarget
  presentation?: MobileAccountPresentation
}) {
  const [expanded, setExpanded] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const title = policy.provider === 'claude' ? 'Claude' : 'Codex'
  const Icon = policy.provider === 'claude' ? ClaudeIcon : OpenAIIcon
  const accounts = view.accounts[policy.provider]
  const enabled = policy.applyToNewWork && policy.strategy !== 'manual'
  const applied = view.policies.find((entry) => entry.id === policy.id)
  const manualBlocked = enabled || Boolean(applied?.applyToNewWork && applied.strategy !== 'manual')
  return (
    <MobileNativePoolRoutingScope
      target={routingTarget}
      provider={policy.provider}
      enabled={expanded}
    >
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title} pool settings`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={styles.row}
        >
          <Icon size={20} />
          <View style={[styles.rowMain, poolStyles.headerText]}>
            <Text style={styles.rowTitle}>{title}</Text>
            <Text style={styles.rowSubtitle}>
              {enabled ? 'Pool enabled' : 'Manual account selection'}
              {' · '}
              {accounts.accounts.length} saved accounts{dirty ? ' · Unsaved changes' : ''}
            </Text>
          </View>
          {expanded ? (
            <ChevronDown size={18} color={colors.textSecondary} />
          ) : (
            <ChevronRight size={18} color={colors.textSecondary} />
          )}
        </Pressable>
        {expanded ? (
          <View style={poolStyles.content}>
            <Text style={styles.rowSubtitle}>
              Manual mode uses the selected account. Automatic pool mode chooses from the same
              accounts below. Save changes before starting new work.
            </Text>
            <MobileAccountPoolLaunchSettings
              policy={policy}
              disabled={disabled}
              onChange={onChange}
            />
            <MobileNativePoolRoutingNotice />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${policy.provider} pool mode`}
              disabled={disabled}
              style={poolStyles.action}
              onPress={() => onPick()}
            >
              <Text style={poolStyles.actionText}>
                Selection: {policy.strategy === 'manual' ? 'sequential' : policy.strategy}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${title} pool advanced settings`}
              accessibilityState={{ expanded: advanced }}
              style={poolStyles.action}
              onPress={() => setAdvanced(!advanced)}
            >
              <Text style={poolStyles.actionText}>
                {advanced ? 'Hide eligibility settings' : 'Eligibility settings'}
              </Text>
            </Pressable>
            {advanced ? (
              <>
                <View style={poolStyles.toggleRow}>
                  <Text style={[styles.rowTitle, styles.rowMain]}>Allow unknown quota</Text>
                  <MobileSwitch
                    accessibilityLabel={`${policy.provider} allow unknown quota`}
                    disabled={disabled}
                    value={policy.unknownQuota === 'allow'}
                    onValueChange={(allow) =>
                      onChange({ ...policy, unknownQuota: allow ? 'allow' : 'exclude' })
                    }
                  />
                </View>
                <Text style={styles.rowSubtitle}>
                  Unknown limits do not prove available capacity.
                </Text>
                <View style={poolStyles.toggleRow}>
                  <Text style={[styles.rowTitle, styles.rowMain]}>Use reserve accounts</Text>
                  <MobileSwitch
                    accessibilityLabel={`${policy.provider} allow reserve accounts`}
                    disabled={disabled}
                    value={policy.allowReserve}
                    onValueChange={(allowReserve) => onChange({ ...policy, allowReserve })}
                  />
                </View>
              </>
            ) : null}
            {accounts.accounts.length === 0 ? (
              <Text style={styles.rowSubtitle}>
                No saved accounts on this host. Manual CLI login is still available.
              </Text>
            ) : null}
            {presentation?.renderSystemAccount?.(policy.provider, manualBlocked)}
            {accounts.accounts.map((account) => {
              const member = policy.members.find((entry) => entry.accountId === account.id)
              const controls = (
                <View style={poolStyles.memberSettings}>
                  <MobileNativePoolConnection accountId={account.id} />
                  {!enabled && !presentation && accounts.activeAccountId === account.id ? (
                    <Text style={styles.rowSubtitle}>Default for new manual launches</Text>
                  ) : null}
                  {advanced ? (
                    <Text style={styles.rowSubtitle}>
                      {accountPoolStatus(view, policy, account.id)}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${account.email} pool participation`}
                    disabled={disabled}
                    style={poolStyles.action}
                    onPress={() => onPick(account.id)}
                  >
                    <Text style={poolStyles.actionText}>
                      {member ? `Pool member: ${member.state}` : 'Not in this pool'}
                    </Text>
                  </Pressable>
                  {member ? (
                    <MobileAccountPoolMemberSettings
                      member={member}
                      accountLabel={account.email}
                      balanced={policy.strategy === 'balanced'}
                      disabled={disabled}
                      onChange={(next) =>
                        onChange({
                          ...policy,
                          members: policy.members.map((entry) =>
                            entry.accountId === account.id ? next : entry
                          )
                        })
                      }
                    />
                  ) : null}
                </View>
              )
              return presentation?.renderAccount ? (
                <View key={account.id} style={poolStyles.account}>
                  {presentation.renderAccount(policy.provider, account.id, manualBlocked)}
                  {controls}
                </View>
              ) : (
                <View key={account.id} style={poolStyles.account}>
                  <Text style={styles.rowTitle}>{account.email}</Text>
                  {controls}
                </View>
              )
            })}
            {presentation?.renderProviderFooter?.(policy.provider)}
            {dirty ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Discard ${policy.provider} pool changes`}
                disabled={disabled}
                style={poolStyles.action}
                onPress={onDiscard}
              >
                <Text style={poolStyles.actionText}>Discard unsaved changes</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Save ${policy.provider} pool`}
              disabled={disabled}
              style={poolStyles.action}
              onPress={onSave}
            >
              <Text style={poolStyles.actionText}>Save {title} pool</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </MobileNativePoolRoutingScope>
  )
}
