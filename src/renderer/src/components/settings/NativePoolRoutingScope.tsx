import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  nativePoolConnectionMethod,
  readNativePoolConnectionState,
  type NativePoolConnectionState
} from '../../../../shared/native-pool-connection-state'
import { NativeClaudeSignInSection } from './NativeClaudeSignInSection'
import { RemoteAccountSignInSection } from './RemoteAccountSignInSection'
import { Button } from '../ui/button'
import { NativeCliShellSetupControl } from './NativeCliShellSetupControl'
import { nativeCliShellSetupInstalled } from '../../../../shared/native-cli-shell-setup'

type RoutingView = {
  state: NativePoolConnectionState | null
  failed: boolean
  refresh: () => void
  target: RuntimeClientTarget
  hostLabel: string
}
const RoutingContext = createContext<RoutingView>({
  state: null,
  failed: false,
  refresh: () => {},
  target: { kind: 'local' },
  hostLabel: 'this host'
})

/** A single on-demand read for the expanded provider, with no background polling. */
export function NativePoolRoutingScope({
  target,
  enabled,
  provider = 'codex',
  hostLabel = 'this host',
  children
}: {
  target: RuntimeClientTarget
  enabled: boolean
  provider?: 'codex' | 'claude'
  hostLabel?: string
  children: ReactNode
}) {
  const [loaded, setLoaded] = useState<{
    owner: string
    state: NativePoolConnectionState | null
    failed: boolean
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const owner = JSON.stringify([provider, environmentId])
  const state = loaded?.owner === owner ? loaded.state : null
  const failed = loaded?.owner === owner ? loaded.failed : false
  const value = useMemo(
    () => ({ state, failed, refresh, target, hostLabel }),
    [state, failed, refresh, target, hostLabel]
  )
  useEffect(() => {
    if (!enabled) {
      return
    }
    const controller = new AbortController()
    const requestTarget: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    void callRuntimeRpc<unknown>(requestTarget, nativePoolConnectionMethod(provider), undefined, {
      signal: controller.signal
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setLoaded({
            owner,
            state: readNativePoolConnectionState(provider, value),
            failed: false
          })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded({ owner, state: null, failed: true })
        }
      })
    return () => controller.abort()
  }, [enabled, environmentId, provider, owner, revision])
  return <RoutingContext.Provider value={value}>{children}</RoutingContext.Provider>
}

export function NativePoolRoutingNotice() {
  const { state, failed, refresh, target, hostLabel } = useContext(RoutingContext)
  if (failed || (state && !state.supported)) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Native CLI switching is unavailable on this host. Check its update and connection.
        </p>
        <Button variant="outline" size="sm" onClick={refresh}>
          Retry CLI connection
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {state
          ? 'Connect each included account once for ordinary CLI commands. Sign in with that same account; it stays in this host’s existing account list.'
          : 'Checking CLI connections…'}
      </p>
      {state?.shellSetup ? (
        <NativeCliShellSetupControl
          setup={state.shellSetup}
          target={target}
          hostLabel={hostLabel}
          onComplete={refresh}
        />
      ) : null}
      {state ? (
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh CLI connections
        </Button>
      ) : null}
    </div>
  )
}

export function NativePoolConnection({
  target,
  hostLabel,
  accountId
}: {
  target: RuntimeClientTarget
  hostLabel: string
  accountId: string
}) {
  const { state, failed, refresh } = useContext(RoutingContext)
  const account = state?.accounts.find((entry) => entry.accountId === accountId)
  const owner = target.kind === 'environment' ? target.environmentId : 'local'
  if (failed || (state && !state.supported)) {
    return null
  }
  if (!state) {
    return null
  }
  if (!account) {
    return (
      <p className="text-xs text-muted-foreground">
        Sign in to this account in Accounts before connecting CLI switching.
      </p>
    )
  }
  if (account.provider === 'claude') {
    if (account.status === 'ready') {
      return (
        <p className="text-xs text-muted-foreground">
          {state.shellSetup && !nativeCliShellSetupInstalled(state.shellSetup)
            ? 'Account connected'
            : 'CLI switching ready'}
        </p>
      )
    }
    if (account.status !== 'needs-sign-in') {
      return (
        <p className="text-xs text-muted-foreground">
          {account.status === 'signing-in'
            ? 'A sign-in is already running for this account. Finish or cancel it before connecting again.'
            : account.status === 'unsupported'
              ? 'CLI switching is unavailable for this Claude installation.'
              : 'A previous Claude sign-in is still live or unverifiable. Resolve it before reconnecting.'}
        </p>
      )
    }
    return (
      <NativeClaudeSignInSection
        key={`${owner}:${accountId}`}
        target={target}
        accountId={accountId}
        onComplete={refresh}
      />
    )
  }
  if (account.status !== 'needs-sign-in') {
    return (
      <p className="text-xs text-muted-foreground">
        {account.status === 'ready'
          ? state.shellSetup && !nativeCliShellSetupInstalled(state.shellSetup)
            ? 'Account connected'
            : 'CLI switching ready'
          : 'CLI connection saved'}
      </p>
    )
  }
  return (
    <RemoteAccountSignInSection
      key={`${owner}:${accountId}:${account.rosterRevision}`}
      target={target}
      hostLabel={hostLabel}
      onComplete={refresh}
      routingAccount={{ accountId, expectedRosterRevision: account.rosterRevision }}
    />
  )
}
