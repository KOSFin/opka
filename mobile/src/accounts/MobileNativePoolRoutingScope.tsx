import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { Pressable, Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import {
  readNativePoolConnectionState,
  type NativePoolConnectionState
} from '../../../src/shared/native-pool-connection-state'
import { nativeClaudeSourcesRead } from './mobile-native-claude-sign-in-operations'
import { nativeCliShellSetupInstalled } from '../../../src/shared/native-cli-shell-setup'
import { MobileNativeShellSetupControl } from './MobileNativeShellSetupControl'
import { MobileNativeClaudeConnection } from './MobileNativeClaudeConnection'
import { codexRoutingStateRead } from './mobile-account-enrollment-operations'
import { MobileAccountSignInSection } from './MobileAccountSignInSection'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

export type MobileNativePoolRoutingTarget = {
  client: RpcClient | null
  connected: boolean
  hostName: string
}
type Target = MobileNativePoolRoutingTarget
type RoutingView = Target & {
  state: NativePoolConnectionState | null
  failed: boolean
  provider: 'claude' | 'codex'
  refresh: () => void
}
const RoutingContext = createContext<RoutingView | null>(null)

export function MobileNativePoolRoutingScope({
  target,
  enabled,
  provider = 'codex',
  children
}: {
  target?: Target
  enabled: boolean
  provider?: 'claude' | 'codex'
  children: ReactNode
}) {
  const client = target?.client ?? null
  const connected = target?.connected === true
  const generation = client?.getGeneration?.() ?? 0
  const [loaded, setLoaded] = useState<{
    client: RpcClient
    generation: number
    provider: 'claude' | 'codex'
    state: NativePoolConnectionState | null
    failed: boolean
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    if (!enabled || !connected || !client) {
      return
    }
    let stale = false
    const request =
      provider === 'codex'
        ? codexRoutingStateRead.request(client).then(codexRoutingStateRead.interpret)
        : nativeClaudeSourcesRead.request(client).then(nativeClaudeSourcesRead.interpret)
    void request
      .then((result) => {
        if (!stale && (client.getGeneration?.() ?? 0) === generation) {
          setLoaded({
            client,
            generation,
            provider,
            state: readNativePoolConnectionState(provider, result),
            failed: false
          })
        }
      })
      .catch(() => {
        if (!stale && (client.getGeneration?.() ?? 0) === generation) {
          setLoaded({ client, generation, provider, state: null, failed: true })
        }
      })
    return () => {
      stale = true
    }
  }, [client, connected, enabled, generation, revision, provider])
  const current =
    loaded?.client === client && loaded.generation === generation && loaded.provider === provider
      ? loaded
      : null
  const state = current?.state ?? null
  const failed = current?.failed ?? false
  const hostName = target?.hostName ?? ''
  const value = useMemo(
    () => ({ client, connected: connected && enabled, hostName, state, failed, refresh, provider }),
    [client, connected, enabled, hostName, state, failed, refresh, provider]
  )
  return <RoutingContext.Provider value={value}>{children}</RoutingContext.Provider>
}

export function MobileNativePoolRoutingNotice() {
  const value = useContext(RoutingContext)
  if (!value?.client) {
    return null
  }
  if (value.failed || (value.state && !value.state.supported)) {
    return (
      <View style={poolStyles.memberSettings}>
        <Text style={styles.rowSubtitle}>
          Native CLI switching is unavailable on this host. Check its update and connection.
        </Text>
        <Pressable
          accessibilityRole="button"
          style={poolStyles.action}
          onPress={value.refresh}
          disabled={!value.connected}
        >
          <Text style={poolStyles.actionText}>Retry CLI connection</Text>
        </Pressable>
      </View>
    )
  }
  return (
    <View style={poolStyles.memberSettings}>
      <Text style={styles.rowSubtitle}>
        {value.state
          ? 'Connect each included account once for ordinary CLI commands. Sign in with that same account; it stays in this host’s account list.'
          : 'Checking CLI connections…'}
      </Text>
      {value.state?.shellSetup ? (
        <MobileNativeShellSetupControl
          setup={value.state.shellSetup}
          client={value.client}
          connected={value.connected}
          hostName={value.hostName || 'this host'}
          onComplete={value.refresh}
        />
      ) : null}
      {value.state ? (
        <Pressable
          accessibilityRole="button"
          style={poolStyles.action}
          onPress={value.refresh}
          disabled={!value.connected}
        >
          <Text style={poolStyles.actionText}>Refresh CLI connections</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export function MobileNativePoolConnection({ accountId }: { accountId: string }) {
  const value = useContext(RoutingContext)
  const account = value?.state?.accounts.find((entry) => entry.accountId === accountId)
  if (!value?.state?.supported || value.failed) {
    return null
  }
  if (!account) {
    return (
      <Text style={styles.rowSubtitle}>
        Sign in to this account in Accounts before connecting CLI switching.
      </Text>
    )
  }
  if (account.provider === 'claude') {
    return (
      <MobileNativeClaudeConnection
        key={accountId}
        client={value.client}
        connected={value.connected}
        accountId={accountId}
        status={account.status}
        onComplete={value.refresh}
        shellSetupInstalled={
          value.state.shellSetup ? nativeCliShellSetupInstalled(value.state.shellSetup) : undefined
        }
      />
    )
  }
  if (account.status !== 'needs-sign-in') {
    return (
      <Text style={styles.rowSubtitle}>
        {account.status === 'ready'
          ? value.state.shellSetup && !nativeCliShellSetupInstalled(value.state.shellSetup)
            ? 'Account connected'
            : 'CLI switching ready'
          : 'CLI connection saved'}
      </Text>
    )
  }
  return (
    <MobileAccountSignInSection
      key={`${accountId}:${account.rosterRevision}`}
      client={value.client}
      connected={value.connected}
      hostName={value.hostName}
      onComplete={value.refresh}
      routingAccount={{ accountId, expectedRosterRevision: account.rosterRevision }}
    />
  )
}
