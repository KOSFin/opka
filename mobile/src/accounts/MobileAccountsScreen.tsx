import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, ScrollView, ActivityIndicator } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
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
import { MobileProviderAccountsDisclosure } from './MobileProviderAccountsDisclosure'
import type { MobileAccountsUsageRouteParams } from './mobile-accounts-route'
import { useMobileAccountsRouteParams } from './use-mobile-accounts-route-params'
import { MobileHomeUsageEntry } from './MobileHomeUsageEntry'

type AccountsNotice = { title: string; message: string }

/**
 * The host's agent accounts. Drawn by the page, so prompts are `ConfirmModal`s rather than
 * `Alert.alert` (a no-op on React Native Web) and Back is the handoff's, which pops the shell.
 */
export function MobileAccountsScreen() {
  const { hostId, usageParams } = useMobileAccountsRouteParams()
  return <HostAccountsScreen key={hostId} hostId={hostId} usageParams={usageParams} />
}

function HostAccountsScreen({
  hostId,
  usageParams
}: {
  hostId: string
  usageParams: MobileAccountsUsageRouteParams
}) {
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()

  // Why: shared client per host. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const [hostName, setHostName] = useState<string>('')
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const currentSnapshot = useRef(snapshot)
  currentSnapshot.current = snapshot
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const screenActive = useScreenActive()
  const [notice, setNotice] = useState<AccountsNotice | null>(null)
  const [enrollmentRevision, setEnrollmentRevision] = useState(0)
  const snapshotRevision = useRef(0)
  const refreshRequest = useRef(0)
  const currentClient = useRef(client)
  currentClient.current = client
  const connectedNow = useRef(screenActive && connState === 'connected')
  connectedNow.current = screenActive && connState === 'connected'

  useEffect(() => {
    refreshRequest.current += 1
    setRefreshing(false)
  }, [client])

  const acceptSnapshot = useCallback((nextSnapshot: AccountsSnapshot) => {
    snapshotRevision.current += 1
    setSnapshot(nextSnapshot)
    setError(null)
  }, [])
  const rejectInvalidSnapshot = useCallback(() => {
    // Why: a stale snapshot can expose a finite reset action for the wrong
    // account; fail closed if a host sends a shape this mobile cannot prove.
    snapshotRevision.current += 1
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
  const currentConfirmReset = useRef(confirmCodexReset)
  currentConfirmReset.current = confirmCodexReset

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
    let active = true
    const unsubscribe = client.subscribe('accounts.subscribe', null, (payload) => {
      if (!active || currentClient.current !== client || !payload || typeof payload !== 'object') {
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
    return () => {
      active = false
      unsubscribe()
    }
  }, [acceptSnapshot, client, connState, rejectInvalidSnapshot, screenActive])

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    const request = ++refreshRequest.current
    const revision = snapshotRevision.current
    setRefreshing(true)
    try {
      const res = await client.sendRequest('accounts.list')
      if (
        request !== refreshRequest.current ||
        currentClient.current !== client ||
        revision !== snapshotRevision.current
      ) {
        return
      }
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result))
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      if (
        request !== refreshRequest.current ||
        currentClient.current !== client ||
        revision !== snapshotRevision.current
      ) {
        return
      }
      if (e instanceof Error && e.message === 'Invalid accounts snapshot from host') {
        rejectInvalidSnapshot()
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (request === refreshRequest.current && currentClient.current === client) {
        setRefreshing(false)
      }
    }
  }, [acceptSnapshot, client, rejectInvalidSnapshot])

  const selectAccount = useCallback(
    async (provider: ProviderKey, accountId: string | null) => {
      const latestSnapshot = currentSnapshot.current
      if (
        !client ||
        currentClient.current !== client ||
        !connectedNow.current ||
        !latestSnapshot ||
        (accountId !== null &&
          !latestSnapshot[provider].accounts.some((account) => account.id === accountId))
      ) {
        return
      }
      const codexTarget = provider === 'codex' ? latestSnapshot.rateLimits.codexTarget : null
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
    [client, refresh]
  )

  const renderProviderFooter = (provider: ProviderKey, onResetPress: () => void) => {
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
        onPress={onResetPress}
      />
    ) : null
  }
  const renderProviderSignIn = (provider: ProviderKey) => (
    <MobileAccountSignInSection
      key={`sign-in:${hostId}:${provider}`}
      provider={provider}
      hostId={hostId}
      client={client}
      connected={screenActive && connState === 'connected'}
      hostName={hostName}
      onComplete={() => {
        setEnrollmentRevision((revision) => revision + 1)
        void refresh()
      }}
    />
  )
  const renderAccountRow = (
    provider: ProviderKey,
    accountId: string | null,
    manualSelectionBlocked: boolean,
    initiallyExpanded = false
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
        initiallyExpanded={initiallyExpanded}
        onSelect={(provider, id) => void selectAccount(provider, id)}
        renderResetAction={(closeThen) =>
          provider === 'codex' &&
          getProviderAccountSelection(snapshot, provider).accountId === accountId
            ? renderProviderFooter(provider, () => closeThen(() => currentConfirmReset.current()))
            : null
        }
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
            {connState !== 'connected' || error ? (
              <Text style={styles.rowSubtitle} accessibilityRole={error ? 'alert' : undefined}>
                {error
                  ? `Last known accounts for ${hostName || 'this host'} · ${error}`
                  : `Last known accounts for ${hostName || 'this host'} · reconnect to refresh quotas and actions`}
              </Text>
            ) : null}
            <MobileHomeUsageEntry
              hostId={hostId}
              snapshot={snapshot}
              usageParams={usageParams}
              available={connState === 'connected' && !error}
              renderAccountRow={renderAccountRow}
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
                renderProviderSignIn,
                renderAccount: (provider, id, blocked) => renderAccountRow(provider, id, blocked),
                renderUnavailableAccounts: (blocked) =>
                  (['claude', 'codex'] as const).map((provider) => (
                    <MobileProviderAccountsDisclosure
                      key={provider}
                      provider={provider}
                      summary={`${snapshot[provider].accounts.length} saved accounts · ${getProviderAccountSelection(snapshot, provider).accountId ? 'specific account' : 'CLI login'}`}
                    >
                      {renderProviderSignIn(provider)}
                      {renderAccountRow(provider, null, blocked)}
                      {snapshot[provider].accounts.map((account) => (
                        <View key={account.id}>
                          {renderAccountRow(provider, account.id, blocked)}
                        </View>
                      ))}
                    </MobileProviderAccountsDisclosure>
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
