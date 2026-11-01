import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import { accountPoolDrafts, setPoolMembership } from '../../../src/shared/account-pool-view'
import type { AccountPoolView } from '../../../src/shared/account-pool-view'
import type { RpcClient } from '../transport/rpc-client'
import { accountPoolsRead, accountPoolUpdate } from './mobile-account-enrollment-operations'
import { PickerModal } from '../components/PickerModal'
import { MobileAccountPoolCard } from './MobileAccountPoolCard'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

type PoolPicker = { policyId: string; accountId?: string; value: string }
export function MobileAccountPoolSection({
  client,
  connected,
  hostName,
  refreshKey = 0
}: {
  client: RpcClient | null
  connected: boolean
  hostName: string
  refreshKey?: number
}) {
  const dirty = useRef(new Set<string>())
  const generation = client?.getGeneration?.() ?? 0
  const ownerClient = useRef({ client, generation })
  const latestOwner = useRef({ client, generation })
  latestOwner.current = { client, generation }
  const verifiedOwner = useRef<typeof ownerClient.current | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const owns = (owner: typeof ownerClient.current) =>
    mounted.current &&
    owner.client === latestOwner.current.client &&
    owner.generation === latestOwner.current.generation &&
    owner.generation === (owner.client?.getGeneration?.() ?? 0)
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
    const requestOwner = { client, generation }
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      const next = accountPoolsRead.interpret(await accountPoolsRead.request(client))
      if (!owns(requestOwner)) {
        return
      }
      verifiedOwner.current = requestOwner
      setView(next)
      setDrafts((previous) =>
        accountPoolDrafts(next).map((policy) =>
          dirty.current.has(policy.id)
            ? (previous.find((entry) => entry.id === policy.id) ?? policy)
            : policy
        )
      )
    } catch (cause) {
      if (owns(requestOwner)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (owns(requestOwner)) {
        setBusy(false)
      }
    }
  }, [client, connected, generation])
  useEffect(() => {
    let stale = false
    const requestOwner = { client, generation }
    if (ownerClient.current.client !== client || ownerClient.current.generation !== generation) {
      ownerClient.current = requestOwner
      verifiedOwner.current = null
      setPicker(null)
      dirty.current.clear()
      setView(null)
      setDrafts([])
      setSaved(false)
    }
    if (!client || !connected) {
      return
    }
    setBusy(true)
    void accountPoolsRead
      .request(client)
      .then((result) => {
        if (stale || !owns(requestOwner)) {
          return
        }
        const next = accountPoolsRead.interpret(result)
        verifiedOwner.current = requestOwner
        setView(next)
        setDrafts((previous) =>
          accountPoolDrafts(next).map((policy) =>
            dirty.current.has(policy.id)
              ? (previous.find((entry) => entry.id === policy.id) ?? policy)
              : policy
          )
        )
        setError('')
      })
      .catch((cause: unknown) => {
        if (!stale && owns(requestOwner)) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (!stale && owns(requestOwner)) {
          setBusy(false)
        }
      })
    return () => {
      stale = true
    }
  }, [client, connected, refreshKey, generation])
  function change(policy: AccountPoolPolicy) {
    if (!owns({ client, generation })) {
      return
    }
    dirty.current.add(policy.id)
    setDrafts((previous) => previous.map((entry) => (entry.id === policy.id ? policy : entry)))
    setSaved(false)
  }
  async function save(policy: AccountPoolPolicy) {
    if (!client || !connected || busy || !verifiedOwner.current || !owns(verifiedOwner.current)) {
      return
    }
    const requestOwner = { client, generation }
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
      if (!owns(requestOwner)) {
        return
      }
      const next = accountPoolsRead.interpret(await accountPoolsRead.request(client))
      if (!owns(requestOwner)) {
        return
      }
      setView(next)
      setDrafts((previous) =>
        previous.map((entry) =>
          entry.id === policy.id
            ? (next.policies.find((savedPolicy) => savedPolicy.id === policy.id) ?? entry)
            : entry
        )
      )
      dirty.current.delete(policy.id)
      setSaved(true)
    } catch (cause) {
      if (owns(requestOwner)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (owns(requestOwner)) {
        setBusy(false)
      }
    }
  }
  function pick(value: string) {
    if (!owns({ client, generation })) {
      return
    }
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
            <MobileAccountPoolCard
              key={policy.id}
              policy={policy}
              view={view}
              disabled={disabled}
              dirty={dirty.current.has(policy.id)}
              onDiscard={() => {
                if (!owns({ client, generation })) {
                  return
                }
                dirty.current.delete(policy.id)
                const saved = accountPoolDrafts(view).find((entry) => entry.id === policy.id)
                if (saved) {
                  setDrafts((previous) =>
                    previous.map((entry) => (entry.id === policy.id ? saved : entry))
                  )
                }
              }}
              onChange={change}
              onSave={() => void save(policy)}
              onPick={(accountId) => {
                if (!owns({ client, generation })) {
                  return
                }
                setPicker({
                  policyId: policy.id,
                  accountId,
                  value: accountId
                    ? (policy.members.find((m) => m.accountId === accountId)?.state ?? 'excluded')
                    : policy.strategy
                })
              }}
            />
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
