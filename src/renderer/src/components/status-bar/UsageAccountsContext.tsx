import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import {
  getProviderAccountsOwnerKey,
  watchProviderAccounts,
  type ProviderAccountsWatcher,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import { useAppStore } from '../../store'
import { getCodexAccountSyncKey } from './codex-switcher-projection'
import { getClaudeAccountSyncKey } from './provider-account-sync-key'

export type UsageAccounts = {
  target: RuntimeClientTarget
  snapshot: ProviderAccountsSnapshot | null
  rateLimits: RateLimitState
  verified: boolean
  ownerLabel?: string
}
const UsageAccountsContext = createContext<UsageAccounts | null>(null)
export const useUsageAccounts = () => useContext(UsageAccountsContext)

type LocalAccountsSnapshot = { snapshot: ProviderAccountsSnapshot | null; verified: boolean }
type LocalAccountsRead = { codexSync: string; claudeSync: string }

function createLocalAccountsSource(owner: string) {
  let current: LocalAccountsSnapshot = { snapshot: null, verified: false }
  let activeRead: LocalAccountsRead | null = null
  return {
    owner,
    getSnapshot: () => current,
    beginRead: (codexSync: string, claudeSync: string): LocalAccountsRead => {
      activeRead = { codexSync, claudeSync }
      return activeRead
    },
    publish: (next: LocalAccountsSnapshot, read: LocalAccountsRead): boolean => {
      if (activeRead !== read) {
        return false
      }
      current = next
      return true
    }
  }
}

export function UsageAccountsProvider({
  target,
  snapshot,
  verified,
  rateLimits = createEmptyRateLimitState(),
  ownerLabel,
  children
}: Omit<UsageAccounts, 'rateLimits'> & {
  rateLimits?: RateLimitState
  children: ReactNode
}): React.JSX.Element {
  const owner = getProviderAccountsOwnerKey(target)
  const codexSync = useAppStore((state) => getCodexAccountSyncKey(state.settings))
  const claudeSync = useAppStore((state) => getClaudeAccountSyncKey(state.settings))
  const refreshClaude = useAppStore((state) => state.fetchInactiveClaudeAccountUsage)
  const refreshCodex = useAppStore((state) => state.fetchInactiveCodexAccountUsage)
  const localSource = useMemo(() => createLocalAccountsSource(owner), [owner])
  const subscribeLocal = useCallback(
    (notify: () => void) => {
      if (owner !== 'local') {
        return () => {}
      }
      let active = true
      let received = false
      const read = localSource.beginRead(codexSync, claudeSync)
      const publish = (next: LocalAccountsSnapshot): void => {
        if (active && localSource.publish(next, read)) {
          notify()
        }
      }
      void Promise.allSettled([
        Promise.resolve().then(() => refreshClaude?.()),
        Promise.resolve().then(() => refreshCodex?.())
      ])
      let watcher: ProviderAccountsWatcher | undefined
      try {
        watcher = watchProviderAccounts(
          { kind: 'local' },
          {
            onSnapshot: (snapshot) => {
              if (active) {
                received = true
                publish({ snapshot, verified: true })
              }
            },
            onError: () => {
              if (!received) {
                publish({ snapshot: localSource.getSnapshot().snapshot, verified: false })
              }
            }
          }
        )
      } catch {
        publish({ snapshot: localSource.getSnapshot().snapshot, verified: false })
      }
      return () => {
        active = false
        watcher?.close()
      }
    },
    [owner, localSource, codexSync, claudeSync, refreshClaude, refreshCodex]
  )
  const local = useSyncExternalStore(
    subscribeLocal,
    localSource.getSnapshot,
    localSource.getSnapshot
  )
  const value = useMemo<UsageAccounts>(
    () =>
      target.kind === 'local'
        ? {
            target,
            rateLimits,
            ownerLabel,
            snapshot: localSource.owner === owner ? local.snapshot : null,
            verified: localSource.owner === owner && local.verified
          }
        : { target, rateLimits, ownerLabel, snapshot, verified },
    [target, rateLimits, ownerLabel, local, localSource, owner, snapshot, verified]
  )
  return <UsageAccountsContext.Provider value={value}>{children}</UsageAccountsContext.Provider>
}
