import { invalidateGitLabTaskLists } from './gitlab-task-list-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'

type Payload = Extract<DetailPayload, { provider: 'gitlab' }>
type Entry = { payload: Payload; savedAt: number; bytes: number }
type Cache = { generation: number; epoch: number; entries: Map<string, Entry>; bytes: number }
const owners = new WeakMap<RpcClient, Cache>()
const MAX_ENTRIES = 24
const MAX_BYTES = 2 * 1024 * 1024
const MAX_AGE_MS = 60_000

export function gitLabMrDetailKey(item: ActionableTaskItem | null): string | null {
  if (item?.provider !== 'gitlab' || item.source.type !== 'mr') {
    return null
  }
  const source = item.source
  return JSON.stringify([
    item.provider,
    source.repoId,
    source.projectRef?.host,
    source.projectRef?.path,
    source.type,
    source.number,
    source.updatedAt
  ])
}

function owner(client: RpcClient): Cache {
  const generation = client.getGeneration?.() ?? 0
  const cached = owners.get(client)
  if (cached?.generation === generation) {
    return cached
  }
  const next: Cache = { generation, epoch: 0, entries: new Map(), bytes: 0 }
  owners.set(client, next)
  return next
}

export function readGitLabMrDetail(
  client: RpcClient,
  key: string,
  now = Date.now()
): Payload | null {
  const cache = owner(client)
  const entry = cache.entries.get(key)
  if (!entry) {
    return null
  }
  if (now - entry.savedAt >= MAX_AGE_MS) {
    cache.entries.delete(key)
    cache.bytes -= entry.bytes
    return null
  }
  cache.entries.delete(key)
  cache.entries.set(key, entry)
  return entry.payload
}

export function gitLabMrCacheEpoch(client: RpcClient): number {
  return owner(client).epoch
}

export function invalidateGitLabMrItem(client: RpcClient, item: ActionableTaskItem): void {
  if (item.provider === 'gitlab') {
    invalidateGitLabTaskLists(client)
  }
  const key = gitLabMrDetailKey(item)
  if (key) {
    invalidateGitLabMrDetail(client, key)
  }
}

export function invalidateGitLabMrDetail(client: RpcClient, key: string): void {
  const cache = owner(client)
  cache.epoch += 1
  const entry = cache.entries.get(key)
  if (entry) {
    cache.entries.delete(key)
    cache.bytes -= entry.bytes
  }
}

export function saveGitLabMrDetail(
  client: RpcClient,
  key: string,
  payload: Payload,
  now = Date.now(),
  expectedEpoch?: number
): void {
  const cache = owner(client)
  if (expectedEpoch !== undefined && expectedEpoch !== cache.epoch) {
    return
  }
  invalidateGitLabMrDetail(client, key)
  const bytes = JSON.stringify(payload).length * 2
  if (bytes > MAX_BYTES) {
    return
  }
  cache.entries.set(key, { payload, savedAt: now, bytes })
  cache.bytes += bytes
  while (cache.entries.size > MAX_ENTRIES || cache.bytes > MAX_BYTES) {
    const oldest = cache.entries.keys().next().value
    if (oldest === undefined) {
      break
    }
    invalidateGitLabMrDetail(client, oldest)
  }
}
