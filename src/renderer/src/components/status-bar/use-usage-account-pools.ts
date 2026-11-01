import { useEffect, useState } from 'react'
import { getProviderAccountsOwnerKey } from '@/runtime/runtime-provider-accounts-client'
import { useUsageAccounts } from './UsageAccountsContext'
import { peekUsageAccountPools, readUsageAccountPools } from './usage-account-pool-cache'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AccountPoolView } from '../../../../shared/account-pool-view'

type State = { owner: string; view: AccountPoolView | null; verified: boolean }

export function useUsageAccountPools(): { view: AccountPoolView | null; verified: boolean } {
  const source = useUsageAccounts()
  const owner = source ? getProviderAccountsOwnerKey(source.target) : null
  const environmentId = source?.target.kind === 'environment' ? source.target.environmentId : null
  const [state, setState] = useState<State | null>(null)
  const verified = source?.verified ?? false
  useEffect(() => {
    if (!owner || !verified) {
      return
    }
    const target: RuntimeClientTarget = environmentId
      ? { kind: 'environment', environmentId }
      : { kind: 'local' }
    let active = true
    const cached = peekUsageAccountPools(target)
    setState({ owner, view: cached?.view ?? null, verified: false })
    void readUsageAccountPools(target).then(
      (entry) => {
        if (active) {
          setState({ owner, view: entry.view, verified: true })
        }
      },
      () => {
        if (active) {
          setState({ owner, view: cached?.view ?? null, verified: false })
        }
      }
    )
    return () => {
      active = false
    }
  }, [owner, environmentId, verified])
  return state?.owner === owner
    ? { view: state.view, verified: state.verified && verified }
    : { view: null, verified: false }
}
