import { createContext, useContext, useEffect, useMemo, useState } from 'react'
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
  const [local, setLocal] = useState<{
    owner: string
    snapshot: ProviderAccountsSnapshot | null
    verified: boolean
  } | null>(null)
  useEffect(() => {
    if (owner !== 'local') {
      return
    }
    let active = true
    let received = false
    void Promise.allSettled([
      Promise.resolve().then(() => refreshClaude?.()),
      Promise.resolve().then(() => refreshCodex?.())
    ])
    let watcher: ProviderAccountsWatcher | undefined
    try {
      watcher = watchProviderAccounts(
        { kind: 'local' },
        {
          onSnapshot: (next) => {
            if (active) {
              received = true
              setLocal({ owner, snapshot: next, verified: true })
            }
          },
          onError: () => {
            if (active && !received) {
              setLocal((previous) => ({
                owner,
                snapshot: previous?.owner === owner ? previous.snapshot : null,
                verified: false
              }))
            }
          }
        }
      )
    } catch {
      setLocal({ owner, snapshot: null, verified: false })
    }
    return () => {
      active = false
      watcher?.close()
    }
  }, [owner, codexSync, claudeSync, refreshClaude, refreshCodex])
  const value = useMemo<UsageAccounts>(
    () =>
      target.kind === 'local'
        ? {
            target,
            rateLimits,
            ownerLabel,
            snapshot: local?.owner === owner ? local.snapshot : null,
            verified: local?.owner === owner && local.verified
          }
        : { target, rateLimits, ownerLabel, snapshot, verified },
    [target, rateLimits, ownerLabel, local, owner, snapshot, verified]
  )
  return <UsageAccountsContext.Provider value={value}>{children}</UsageAccountsContext.Provider>
}
