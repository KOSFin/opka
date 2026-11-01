import { useCallback, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  fetchProviderAccountsSnapshot,
  getProviderAccountsOwnerKey,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import { useUsageAccounts } from './UsageAccountsContext'

export function useUsageAccountSource<P extends 'claude' | 'codex'>(
  target: RuntimeClientTarget,
  provider: P,
  onRoster: (roster: ProviderAccountsSnapshot[P]) => void
) {
  const context = useUsageAccounts()
  const owner = getProviderAccountsOwnerKey(target)
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const [last, setLast] = useState<{ owner: string; snapshot: ProviderAccountsSnapshot } | null>(
    null
  )
  const hasContext = context !== null && getProviderAccountsOwnerKey(context.target) === owner
  const supplied = hasContext ? context.snapshot : null
  const healthy = supplied && !supplied.failedProviders?.includes(provider) ? supplied : null
  const retained = healthy ?? (last?.owner === owner ? last.snapshot : null)
  const snapshot =
    retained && hasContext && (!context.verified || supplied?.failedProviders?.includes(provider))
      ? { ...retained, rateLimits: null }
      : retained
  const loadAccounts = useCallback(async () => {
    if (hasContext && !supplied) {
      return
    }
    const next = hasContext && supplied ? supplied : await fetchProviderAccountsSnapshot(target)
    if (ownerRef.current !== owner || next.failedProviders?.includes(provider)) {
      return
    }
    setLast((previous) =>
      previous?.owner === owner && previous.snapshot === next ? previous : { owner, snapshot: next }
    )
    onRoster(next[provider])
  }, [hasContext, supplied, target, owner, provider, onRoster])
  const acceptRoster = (roster: ProviderAccountsSnapshot[P]): void => {
    onRoster(roster)
    setLast((previous) =>
      previous?.owner === owner
        ? { owner, snapshot: { ...previous.snapshot, [provider]: roster, rateLimits: null } }
        : previous
    )
  }
  return { snapshot, loadAccounts, acceptRoster }
}
