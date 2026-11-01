import type { TaskResumeState } from './mobile-tasks-view-state-types'
import type { RpcClient } from '../transport/rpc-client'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
type Entry = { items: TaskItem[]; notice: string; at: number; bytes: number }
type GitLabPreferences = Pick<TaskResumeState, 'gitlabView' | 'gitlabFilter' | 'gitlabQuery'>
type Owner = {
  generation: number
  epoch: number
  entries: Map<string, Entry>
  bytes: number
  preferences: GitLabPreferences
}
const owners = new WeakMap<RpcClient, Owner>()
function owner(client: RpcClient): Owner {
  const generation = client.getGeneration?.() ?? 0
  const existing = owners.get(client)
  if (existing?.generation === generation) {
    return existing
  }
  const next: Owner = { generation, epoch: 0, entries: new Map(), bytes: 0, preferences: {} }
  owners.set(client, next)
  return next
}
export function readGitLabTaskList(
  client: RpcClient,
  key: string,
  now = Date.now()
): (Entry & { fresh: boolean }) | null {
  const cache = owner(client)
  const entry = cache.entries.get(key)
  if (!entry) {
    return null
  }
  if (now - entry.at >= 600_000) {
    cache.entries.delete(key)
    cache.bytes -= entry.bytes
    return null
  }
  cache.entries.delete(key)
  cache.entries.set(key, entry)
  return { ...entry, fresh: now - entry.at < 60_000 }
}
export function gitLabTaskListEpoch(client: RpcClient): number {
  return owner(client).epoch
}
export function saveGitLabTaskList(
  client: RpcClient,
  key: string,
  items: TaskItem[],
  notice: string,
  now = Date.now(),
  expectedEpoch?: number
): void {
  const cache = owner(client)
  if (expectedEpoch !== undefined && expectedEpoch !== cache.epoch) {
    return
  }
  const previous = cache.entries.get(key)
  if (previous) {
    cache.entries.delete(key)
    cache.bytes -= previous.bytes
  }
  const bytes = JSON.stringify(items).length * 2 + notice.length * 2
  if (bytes > 2 * 1024 * 1024) {
    return
  }
  cache.entries.set(key, { items, notice, bytes, at: now })
  cache.bytes += bytes
  while (cache.entries.size > 12 || cache.bytes > 2 * 1024 * 1024) {
    const first = cache.entries.keys().next().value
    if (first === undefined) {
      break
    }
    cache.bytes -= cache.entries.get(first)?.bytes ?? 0
    cache.entries.delete(first)
  }
}
export function invalidateGitLabTaskLists(client: RpcClient): void {
  const cache = owner(client)
  cache.epoch += 1
  cache.entries.clear()
  cache.bytes = 0
}

export function splitGitLabTaskResumeState(state: TaskResumeState) {
  const { gitlabView, gitlabFilter, gitlabQuery, ...host } = state
  return { preferences: { gitlabView, gitlabFilter, gitlabQuery }, host }
}
export function readGitLabTaskPreferences(client: RpcClient): GitLabPreferences {
  return owner(client).preferences
}
export function saveGitLabTaskPreferences(client: RpcClient, preferences: GitLabPreferences): void {
  if (JSON.stringify(preferences).length < 32_768) {
    owner(client).preferences = preferences
  }
}
