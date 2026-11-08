import { useEffect, useState, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { loadHosts } from '../transport/host-store'
import { useHostClient } from '../transport/host-client-hooks'
import { colors, spacing } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'
import { useNow } from '../hooks/use-now'
import { useScreenActive } from '../hooks/use-screen-active'
import {
  type AccountsSnapshot,
  type ProviderKey,
  decodeAccountsSnapshot
} from '../components/AccountUsage'
import { getCodexResetCreditSummary } from '../components/codex-reset-credit'
import {
  getAccountProviderUsage,
  getProviderAccountSelection
} from '../components/provider-account-usage'
import { CodexResetCreditAction } from '../components/CodexResetCreditAction'
import { useCodexResetCreditAction } from '../components/use-codex-reset-credit-action'
import { ConfirmModal } from '../components/ConfirmModal'
import { useRouteHandoff } from '../navigation/route-handoff'
import { MobileAccountPoolSection } from './MobileAccountPoolSection'
import { MobileAccountSignInSection } from './MobileAccountSignInSection'
import { MobileProviderAccountRow } from './MobileProviderAccountRow'
import { accountPoolSnapshotRefreshKey } from './mobile-account-presentation'
import { MobileAccountsHeader } from './MobileAccountsHeader'

type AccountsNotice = { title: string; message: string }

/**
 * The host's agent accounts. Drawn by the page, so prompts are `ConfirmModal`s rather than
 * `Alert.alert` (a no-op on React Native Web) and Back is the handoff's, which pops the shell.
 */
export function MobileAccountsScreen() {
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()

  // Why: shared client per host. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const [hostName, setHostName] = useState<string>('')
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const screenActive = useScreenActive()
  const [notice, setNotice] = useState<AccountsNotice | null>(null)
  const [enrollmentRevision, setEnrollmentRevision] = useState(0)

  const acceptSnapshot = useCallback((nextSnapshot: AccountsSnapshot) => {
    setSnapshot(nextSnapshot)
    setError(null)
  }, [])
  const rejectInvalidSnapshot = useCallback(() => {
    // Why: a stale snapshot can expose a finite reset action for the wrong
    // account; fail closed if a host sends a shape this mobile cannot prove.
    setSnapshot(null)
    setError('Invalid accounts snapshot from host')
  }, [])
  const {
    supported: codexResetSupported,
    resetting: resettingCodex,
    resetScope,
    scopeLabel: resetScopeLabel,
    confirmReset: confirmCodexReset,
    confirmation: codexResetConfirmation,
    acceptReset: acceptCodexReset,
    cancelReset: cancelCodexReset
  } = useCodexResetCreditAction({
    client,
    connected: screenActive && connState === 'connected',
    snapshot,
    hostName,
    hostId,
    accountMutationBusy: busyAccountId !== null,
    onSnapshot: acceptSnapshot,
    onNotice: setNotice
  })

  // Why: snapshot pushes only arrive when the desktop's rate-limit poll completes.
  const now = useNow(60_000, screenActive)

  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }
      setHostName(host.name)
    })
    return () => {
      stale = true
    }
  }, [hostId])

  // Why: subscribe to streaming snapshot updates so usage bars refresh in
  // place when the desktop's rate-limit poll completes (every 5 min) or
  // when the user switches accounts. Falls back to a one-shot accounts.list
  // if the subscription stream errors.
  useEffect(() => {
    if (!screenActive || !client || connState !== 'connected') {
      return
    }
    const unsubscribe = client.subscribe('accounts.subscribe', null, (payload) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      const evt = payload as { type?: string; snapshot?: unknown }
      if (evt.type === 'ready' || evt.type === 'snapshot') {
        try {
          acceptSnapshot(decodeAccountsSnapshot(evt.snapshot))
        } catch {
          rejectInvalidSnapshot()
        }
      }
    })
    return unsubscribe
  }, [acceptSnapshot, client, connState, rejectInvalidSnapshot, screenActive])

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    setRefreshing(true)
    try {
      const res = await client.sendRequest('accounts.list')
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result))
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'Invalid accounts snapshot from host') {
        rejectInvalidSnapshot()
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRefreshing(false)
    }
  }, [acceptSnapshot, client, rejectInvalidSnapshot])

  const selectAccount = useCallback(
    async (provider: ProviderKey, accountId: string | null) => {
      if (!client) {
        return
      }
      const codexTarget = provider === 'codex' ? snapshot?.rateLimits.codexTarget : null
      if (provider === 'codex' && !codexTarget) {
        return
      }
      setBusyAccountId(accountId ?? `${provider}:default`)
      const method =
        provider === 'claude'
          ? 'accounts.selectClaude'
          : codexTarget?.runtime === 'wsl'
            ? 'accounts.selectCodexForTarget'
            : 'accounts.selectCodex'
      try {
        // Why: old hosts silently strip unknown target fields. Use the distinct
        // targeted RPC for WSL so version skew fails before mutating host state.
        const params =
          codexTarget?.runtime === 'wsl' ? { accountId, target: codexTarget } : { accountId }
        const res = await client.sendRequest(method, params)
        if (!res.ok) {
          setNotice({ title: 'Could not switch account', message: res.error.message })
        } else {
          // Why: optimistic refresh — the streaming subscription will also
          // emit, but a one-shot keeps the UI responsive even if the stream
          // is temporarily disconnected.
          await refresh()
        }
      } catch (e) {
        setNotice({
          title: 'Could not switch account',
          message: e instanceof Error ? e.message : String(e)
        })
      } finally {
        setBusyAccountId(null)
      }
    },
    [client, refresh, snapshot]
  )

  const renderProviderFooter = (provider: ProviderKey) => {
    if (!snapshot || provider !== 'codex') {
      return null
    }
    const { accountId } = getProviderAccountSelection(snapshot, provider)
    const usage = getAccountProviderUsage(snapshot, provider, accountId)
    const resetCredit = getCodexResetCreditSummary(usage, now)
    const usageFresh =
      !!usage &&
      now - usage.updatedAt < 10 * 60_000 &&
      usage.updatedAt <= now + 60_000 &&
      usage.status === 'ok'
    return resetCredit ? (
      <CodexResetCreditAction
        summary={resetCredit}
        scopeLabel={resetScopeLabel}
        unavailableReason={
          !codexResetSupported
            ? 'Reset unavailable on this host'
            : resetCredit.availableCount === 0
              ? 'No resets left'
              : !resetScope
                ? 'Account or usage details changed; refresh to try again'
                : !usageFresh
                  ? 'Last known quota; refresh to use a reset'
                  : null
        }
        busy={resettingCodex}
        disabled={
          !codexResetSupported ||
          !resetScope ||
          !usageFresh ||
          resetCredit.availableCount === 0 ||
          resettingCodex ||
          busyAccountId !== null ||
          connState !== 'connected'
        }
        onPress={confirmCodexReset}
      />
    ) : null
  }
  const renderAccountRow = (
    provider: ProviderKey,
    accountId: string | null,
    manualSelectionBlocked: boolean
  ) =>
    snapshot ? (
      <MobileProviderAccountRow
        snapshot={snapshot}
        provider={provider}
        accountId={accountId}
        manualSelectionBlocked={manualSelectionBlocked}
        disabled={busyAccountId !== null || resettingCodex || connState !== 'connected'}
        busyAccountId={busyAccountId}
        now={now}
        onSelect={(provider, id) => void selectAccount(provider, id)}
      />
    ) : null

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <MobileAccountsHeader
        hostName={hostName}
        refreshing={refreshing}
        disabled={!client || connState !== 'connected'}
        onBack={() => router.back()}
        onRefresh={() => void refresh()}
      />

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        {connState !== 'connected' && !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>Connecting to {hostName || 'host'}…</Text>
          </View>
        ) : error && !snapshot ? (
          <View style={styles.placeholder}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>Loading accounts…</Text>
          </View>
        ) : (
          <>
            <MobileAccountSignInSection
              key={`sign-in:${hostId}`}
              hostId={hostId}
              client={client}
              connected={screenActive && connState === 'connected'}
              hostName={hostName}
              onComplete={() => {
                setEnrollmentRevision((revision) => revision + 1)
                void refresh()
              }}
            />
            <MobileAccountPoolSection
              key={hostId}
              refreshKey={accountPoolSnapshotRefreshKey(snapshot, enrollmentRevision)}
              client={client}
              connected={screenActive && connState === 'connected'}
              hostName={hostName}
              refreshUsage={refresh}
              presentation={{
                renderSystemAccount: (provider, blocked) =>
                  renderAccountRow(provider, null, blocked),
                renderAccount: (provider, id, blocked) => renderAccountRow(provider, id, blocked),
                renderProviderFooter,
                renderUnavailableAccounts: (blocked) =>
                  (['claude', 'codex'] as const).map((provider) => (
                    <View key={provider} style={styles.card}>
                      <Text style={styles.sectionHeading}>
                        {provider === 'claude' ? 'Claude' : 'Codex'}
                      </Text>
                      {renderAccountRow(provider, null, blocked)}
                      {snapshot[provider].accounts.map((account) => (
                        <View key={account.id}>
                          {renderAccountRow(provider, account.id, blocked)}
                        </View>
                      ))}
                      {renderProviderFooter(provider)}
                    </View>
                  ))
              }}
            />
          </>
        )}
      </ScrollView>
      <ConfirmModal
        visible={codexResetConfirmation !== null}
        title={codexResetConfirmation?.title ?? ''}
        message={codexResetConfirmation?.message}
        confirmLabel="Use reset"
        onConfirm={acceptCodexReset}
        onCancel={cancelCodexReset}
      />
      <ConfirmModal
        visible={notice !== null}
        title={notice?.title ?? ''}
        message={notice?.message}
        confirmLabel="OK"
        cancelLabel={null}
        onCancel={() => setNotice(null)}
      />
    </SafeAreaView>
  )
}
