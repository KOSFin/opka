import { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import {
  accountPoolDrafts,
  accountPoolStatus,
  setPoolMembership
} from '../../../src/shared/account-pool-view'
import type { AccountPoolView } from '../../../src/shared/account-pool-view'
import type { RpcClient } from '../transport/rpc-client'
import { accountPoolsRead, accountPoolUpdate } from './mobile-account-enrollment-operations'
import { PickerModal } from '../components/PickerModal'
import { MobileAccountPoolMemberSettings } from './MobileAccountPoolMemberSettings'
import { MobileAccountPoolLaunchSettings } from './MobileAccountPoolLaunchSettings'
import { MobileSwitch } from '../components/MobileSwitch'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

type PoolPicker = { policyId: string; accountId?: string; value: string }
export function MobileAccountPoolSection({
  client,
  connected,
  hostName
}: {
  client: RpcClient | null
  connected: boolean
  hostName: string
}) {
  const [view, setView] = useState<AccountPoolView | null>(null)
  const [drafts, setDrafts] = useState<AccountPoolPolicy[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [picker, setPicker] = useState<PoolPicker | null>(null)
  const refresh = useCallback(async () => {
    if (!client || !connected) {
      return
    }
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      const next = accountPoolsRead.interpret(await accountPoolsRead.request(client))
      setView(next)
      setDrafts(accountPoolDrafts(next))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [client, connected])
  useEffect(() => {
    let stale = false
    setView(null)
    setDrafts([])
    setSaved(false)
    if (!client || !connected) {
      return
    }
    setBusy(true)
    void accountPoolsRead
      .request(client)
      .then((result) => {
        if (stale) {
          return
        }
        const next = accountPoolsRead.interpret(result)
        setView(next)
        setDrafts(accountPoolDrafts(next))
        setError('')
      })
      .catch((cause: unknown) => {
        if (!stale) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (!stale) {
          setBusy(false)
        }
      })
    return () => {
      stale = true
    }
  }, [client, connected])
  function change(policy: AccountPoolPolicy) {
    setDrafts((previous) => previous.map((entry) => (entry.id === policy.id ? policy : entry)))
    setSaved(false)
  }
  async function save(policy: AccountPoolPolicy) {
    if (!client || !connected || busy) {
      return
    }
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      accountPoolUpdate.interpret(
        await accountPoolUpdate.request(client, {
          policy,
          expectedRevision: policy.revision
        })
      )
      const next = accountPoolsRead.interpret(await accountPoolsRead.request(client))
      setView(next)
      setDrafts((previous) =>
        previous.map((entry) =>
          entry.id === policy.id
            ? (next.policies.find((savedPolicy) => savedPolicy.id === policy.id) ?? entry)
            : entry
        )
      )
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  function pick(value: string) {
    const policy = drafts.find((entry) => entry.id === picker?.policyId)
    if (!policy || !picker) {
      return
    }
    if (picker.accountId) {
      if (
        value === 'enabled' ||
        value === 'draining' ||
        value === 'disabled' ||
        value === 'excluded'
      ) {
        change(setPoolMembership(policy, picker.accountId, value))
      }
    } else if (value === 'manual' || value === 'sequential' || value === 'balanced') {
      change({ ...policy, strategy: value })
    }
    setPicker(null)
  }
  const disabled = busy || !connected
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Account pools</Text>
      <Text style={styles.rowSubtitle}>
        Execution host: {hostName || 'this host'}. Pools apply to managed launches on this host.
      </Text>
      <Text style={styles.rowSubtitle}>
        Manual pauses selection. Sequential uses the lowest priority first. Balanced spreads
        launches. Drain stops new assignments.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          Account pools unavailable or could not save. Older hosts may require an update. {error}
        </Text>
      ) : null}
      {!view && !error ? (
        <Text style={styles.rowSubtitle}>
          {connected ? 'Loading pools…' : 'Connect to manage pools.'}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh pools"
        disabled={disabled}
        onPress={() => void refresh()}
        style={poolStyles.action}
      >
        <Text style={poolStyles.actionText}>Refresh pools</Text>
      </Pressable>
      {view
        ? drafts.map((policy) => (
            <View key={policy.id} style={styles.card}>
              <View style={poolStyles.content}>
                <Text style={styles.rowTitle}>
                  {policy.provider === 'claude' ? 'Claude' : 'Codex'}
                </Text>
                <MobileAccountPoolLaunchSettings
                  policy={policy}
                  disabled={disabled}
                  onChange={change}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${policy.provider} pool mode`}
                  disabled={disabled}
                  style={poolStyles.action}
                  onPress={() => setPicker({ policyId: policy.id, value: policy.strategy })}
                >
                  <Text style={poolStyles.actionText}>Mode: {policy.strategy}</Text>
                </Pressable>
                <View style={poolStyles.toggleRow}>
                  <Text style={[styles.rowTitle, styles.rowMain]}>Allow unknown quota</Text>
                  <MobileSwitch
                    accessibilityLabel={`${policy.provider} allow unknown quota`}
                    disabled={disabled}
                    value={policy.unknownQuota === 'allow'}
                    onValueChange={(allow) =>
                      change({ ...policy, unknownQuota: allow ? 'allow' : 'exclude' })
                    }
                  />
                </View>
                {view.accounts[policy.provider].accounts.length === 0 ? (
                  <Text style={styles.rowSubtitle}>
                    No saved accounts on this host. Open Accounts to add a login, then return here.
                  </Text>
                ) : null}
                {view.accounts[policy.provider].accounts.map((account) => {
                  const member = policy.members.find((entry) => entry.accountId === account.id)
                  return (
                    <View key={account.id} style={poolStyles.account}>
                      <Text style={styles.rowTitle}>
                        {account.email}
                        {view.accounts[policy.provider].activeAccountId === account.id
                          ? ' · Selected login'
                          : ''}
                      </Text>
                      <Text style={styles.rowSubtitle}>
                        {accountPoolStatus(view, policy, account.id)}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${account.email} pool participation`}
                        disabled={disabled}
                        style={poolStyles.action}
                        onPress={() =>
                          setPicker({
                            policyId: policy.id,
                            accountId: account.id,
                            value: member?.state ?? 'excluded'
                          })
                        }
                      >
                        <Text style={poolStyles.actionText}>
                          Participation: {member?.state ?? 'excluded'}
                        </Text>
                      </Pressable>
                      {member ? (
                        <MobileAccountPoolMemberSettings
                          member={member}
                          accountLabel={account.email}
                          balanced={policy.strategy === 'balanced'}
                          disabled={disabled}
                          onChange={(next) =>
                            change({
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
                })}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Save ${policy.provider} pool`}
                  disabled={disabled}
                  style={poolStyles.action}
                  onPress={() => void save(policy)}
                >
                  <Text style={poolStyles.actionText}>Save {policy.provider} pool</Text>
                </Pressable>
              </View>
            </View>
          ))
        : null}
      {saved ? (
        <Text accessibilityLiveRegion="polite" style={styles.rowSubtitle}>
          Pool saved on {hostName || 'this host'}.
        </Text>
      ) : null}
      <PickerModal
        visible={picker !== null && !disabled}
        title={picker?.accountId ? 'Pool participation' : 'Pool mode'}
        selected={picker?.value ?? ''}
        options={
          picker?.accountId
            ? [
                { value: 'excluded', label: 'Excluded' },
                { value: 'enabled', label: 'Included' },
                { value: 'draining', label: 'Drain' },
                { value: 'disabled', label: 'Disabled' }
              ]
            : [
                { value: 'manual', label: 'Manual' },
                { value: 'sequential', label: 'Sequential' },
                { value: 'balanced', label: 'Balanced' }
              ]
        }
        onSelect={pick}
        onClose={() => setPicker(null)}
      />
    </View>
  )
}
