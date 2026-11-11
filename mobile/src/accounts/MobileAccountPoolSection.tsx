import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import { ACCOUNT_POOL_EQUALIZE_CAPABILITY } from '../../../src/shared/account-pool-policy'
import { accountPoolDrafts, setPoolMembership } from '../../../src/shared/account-pool-view'
import type { AccountPoolView } from '../../../src/shared/account-pool-view'
import type { RpcClient } from '../transport/rpc-client'
import { accountPoolsRead, accountPoolUpdate } from './mobile-account-enrollment-operations'
import { PickerModal } from '../components/PickerModal'
import { MobileAccountPoolCard } from './MobileAccountPoolCard'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'
import {
  mergeMobileAccountPoolDrafts,
  type MobileAccountPresentation
} from './mobile-account-presentation'

type PoolPicker = { policyId: string; accountId?: string; value: string }
export function MobileAccountPoolSection({
  client,
  connected,
  hostName,
  refreshKey = 0,
  presentation,
  refreshUsage
}: {
  client: RpcClient | null
  connected: boolean
  hostName: string
  refreshKey?: number | string
  presentation?: MobileAccountPresentation
  refreshUsage?: () => Promise<void>
}) {
  const dirty = useRef(new Set<string>())
  const readSequence = useRef(0)
  const saveSequence = useRef<number | null>(null)
  const previousProjection = useRef<number | string | undefined>(undefined)
  const generation = client?.getGeneration?.() ?? 0
  const ownerClient = useRef({ client, generation, hostName })
  const latestOwner = useRef({ client, generation, hostName })
  latestOwner.current = { client, generation, hostName }
  const verifiedOwner = useRef<typeof ownerClient.current | null>(null)
  const reasonPending = useRef(false)
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
    owner.hostName === latestOwner.current.hostName &&
    owner.generation === (owner.client?.getGeneration?.() ?? 0)
  const [view, setView] = useState<AccountPoolView | null>(null)
  const [drafts, setDrafts] = useState<AccountPoolPolicy[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [picker, setPicker] = useState<PoolPicker | null>(null)
  const refresh = useCallback(async () => {
    if (!client || !connected || busy || saveSequence.current !== null) {
      return
    }
    const requestOwner = { client, generation, hostName }
    const sequence = ++readSequence.current
    setBusy(true)
    reasonPending.current = true
    setSaved(false)
    setError('')
    try {
      await refreshUsage?.()
      const next = accountPoolsRead.interpret(await accountPoolsRead.request(client))
      if (!owns(requestOwner) || sequence !== readSequence.current) {
        return
      }
      verifiedOwner.current = requestOwner
      reasonPending.current = false
      setView(next)
      setDrafts((previous) => mergeMobileAccountPoolDrafts(next, previous, dirty.current))
    } catch (cause) {
      if (owns(requestOwner) && sequence === readSequence.current) {
        reasonPending.current = false
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (owns(requestOwner) && sequence === readSequence.current) {
        setBusy(false)
      }
    }
  }, [client, connected, generation, hostName, refreshUsage, busy])
  useEffect(() => {
    let stale = false
    const requestOwner = { client, generation, hostName }
    if (
      ownerClient.current.client !== client ||
      ownerClient.current.generation !== generation ||
      ownerClient.current.hostName !== hostName
    ) {
      ownerClient.current = requestOwner
      verifiedOwner.current = null
      reasonPending.current = false
      previousProjection.current = undefined
      readSequence.current += 1
      saveSequence.current = null
      setBusy(false)
      setPicker(null)
      dirty.current.clear()
      setView(null)
      setDrafts([])
      setSaved(false)
    }
    if (!client || !connected) {
      previousProjection.current = undefined
      return
    }
    if (busy || saveSequence.current !== null || previousProjection.current === refreshKey) {
      return
    }
    previousProjection.current = refreshKey
    reasonPending.current = true
    const sequence = ++readSequence.current
    void accountPoolsRead
      .request(client)
      .then((result) => {
        if (stale || !owns(requestOwner) || sequence !== readSequence.current) {
          return
        }
        const next = accountPoolsRead.interpret(result)
        verifiedOwner.current = requestOwner
        reasonPending.current = false
        setView(next)
        setDrafts((previous) => mergeMobileAccountPoolDrafts(next, previous, dirty.current))
        setError('')
      })
      .catch((cause: unknown) => {
        if (!stale && owns(requestOwner) && sequence === readSequence.current) {
          reasonPending.current = false
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      stale = true
    }
  }, [client, connected, refreshKey, generation, hostName, busy])
  function change(policy: AccountPoolPolicy) {
    if (!owns({ client, generation, hostName })) {
      return
    }
    dirty.current.add(policy.id)
    setDrafts((previous) => previous.map((entry) => (entry.id === policy.id ? policy : entry)))
    setSaved(false)
  }
  async function save(policy: AccountPoolPolicy) {
    if (
      !client ||
      !connected ||
      busy ||
      saveSequence.current !== null ||
      !verifiedOwner.current ||
      !owns(verifiedOwner.current)
    ) {
      return
    }
    const requestOwner = { client, generation, hostName }
    const sequence = ++readSequence.current
    saveSequence.current = sequence
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
      if (!owns(requestOwner) || sequence !== readSequence.current) {
        return
      }
      const next = accountPoolsRead.interpret(await accountPoolsRead.request(client))
      if (!owns(requestOwner) || sequence !== readSequence.current) {
        return
      }
      setView(next)
      reasonPending.current = false
      dirty.current.delete(policy.id)
      setDrafts((previous) => mergeMobileAccountPoolDrafts(next, previous, dirty.current))
      setSaved(true)
    } catch (cause) {
      if (owns(requestOwner) && sequence === readSequence.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (saveSequence.current === sequence) {
        saveSequence.current = null
        if (owns(requestOwner)) {
          setBusy(false)
        }
      }
    }
  }
  function pick(value: string) {
    if (!owns({ client, generation, hostName })) {
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
    } else if (
      value === 'manual' ||
      value === 'sequential' ||
      value === 'balanced' ||
      (value === 'quota-equalize' &&
        policy.provider === 'codex' &&
        view?.equalizeCapability === ACCOUNT_POOL_EQUALIZE_CAPABILITY)
    ) {
      change({ ...policy, strategy: value })
    }
    setPicker(null)
  }
  const disabled = busy || !connected
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Accounts & switching</Text>
      <Text style={styles.rowSubtitle}>
        Execution host: {hostName || 'this host'}. One account list for manual selection and
        automatic pools.
      </Text>
      <Text style={styles.rowSubtitle}>
        Choose manual mode or an automatic pool for each provider. Changes apply after Save.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          Account pools unavailable or could not save. Older hosts may require an update. {error}
        </Text>
      ) : null}
      {!view && error
        ? presentation?.renderUnavailableAccounts?.(
            !/unknown method|method not found|not supported/i.test(error)
          )
        : null}
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
              presentation={presentation}
              policy={policy}
              routingTarget={{ client, connected, hostName }}
              view={view}
              verified={
                connected &&
                !busy &&
                !error &&
                !reasonPending.current &&
                previousProjection.current === refreshKey &&
                !!verifiedOwner.current &&
                owns(verifiedOwner.current)
              }
              disabled={disabled}
              dirty={dirty.current.has(policy.id)}
              onDiscard={() => {
                if (!owns({ client, generation, hostName })) {
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
                if (!owns({ client, generation, hostName })) {
                  return
                }
                setPicker({
                  policyId: policy.id,
                  accountId,
                  value: accountId
                    ? (policy.members.find((m) => m.accountId === accountId)?.state ?? 'excluded')
                    : policy.strategy === 'manual'
                      ? 'sequential'
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
                { value: 'sequential', label: 'Sequential' },
                { value: 'balanced', label: 'Balanced' },
                ...(picker &&
                drafts.find((entry) => entry.id === picker.policyId)?.provider === 'codex' &&
                view?.equalizeCapability === ACCOUNT_POOL_EQUALIZE_CAPABILITY
                  ? [{ value: 'quota-equalize', label: 'Equalize quota usage' }]
                  : [])
              ]
        }
        onSelect={pick}
        onClose={() => setPicker(null)}
      />
    </View>
  )
}
