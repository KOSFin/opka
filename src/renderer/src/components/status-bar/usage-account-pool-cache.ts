import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getProviderAccountsOwnerKey } from '@/runtime/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AccountPoolViewSchema } from '../../../../shared/account-pool-view'
import type { AccountPoolView } from '../../../../shared/account-pool-view'

type Entry = { view: AccountPoolView; updatedAt: number }
const entries = new Map<string, Entry>()
const pending = new Map<string, Promise<Entry>>()
const TTL = 30_000
const MAX_OWNERS = 8

export function peekUsageAccountPools(target: RuntimeClientTarget): Entry | null {
  return entries.get(getProviderAccountsOwnerKey(target)) ?? null
}

export function readUsageAccountPools(target: RuntimeClientTarget): Promise<Entry> {
  const owner = getProviderAccountsOwnerKey(target)
  const cached = entries.get(owner)
  if (cached && Date.now() - cached.updatedAt < TTL) {
    return Promise.resolve(cached)
  }
  const existing = pending.get(owner)
  if (existing) {
    return existing
  }
  const request = Promise.resolve()
    .then(() => callRuntimeRpc(target, 'accountPool.list'))
    .then((result) => {
      const entry = { view: AccountPoolViewSchema.parse(result), updatedAt: Date.now() }
      entries.delete(owner)
      entries.set(owner, entry)
      if (entries.size > MAX_OWNERS) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) {
          entries.delete(oldest)
        }
      }
      return entry
    })
    .finally(() => pending.delete(owner))
  pending.set(owner, request)
  return request
}
