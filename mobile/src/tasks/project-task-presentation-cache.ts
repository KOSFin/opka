import type { RpcClient } from '../transport/rpc-client'
import type { loadProjectTaskBoard } from './project-task-rpc'

export type ProjectTaskSelection = {
  project: string | null
  taskId: string | null
  document: string | null
  query: string
  phase: string
  source: string
  projects: string[]
  projectLimit: number
  catalogScroll: number
  boardScroll: number
}
export type ProjectTaskCatalogRow = {
  selector: string
  name: string
  state: string
  message?: string
  groupId?: string
  groupName?: string
  repositoryName?: string
  projectGroupsAvailable?: boolean
}
export type ProjectTaskEntry =
  | { kind: 'catalog'; projects: ProjectTaskCatalogRow[]; truncated: boolean }
  | { kind: 'board'; project: string; board: Awaited<ReturnType<typeof loadProjectTaskBoard>> }
  | {
      kind: 'detail'
      project: string
      revision: string
      body: string
      content: string
      documents: string[]
    }
  | { kind: 'report'; project: string; report: string }
type Saved = { value: ProjectTaskEntry; bytes: number; at: number }
type Owner = {
  generation: number
  entries: Map<string, Saved>
  selections: Map<string, ProjectTaskSelection>
  bytes: number
}
const owners = new WeakMap<RpcClient, Owner>()
const EMPTY_SELECTION: ProjectTaskSelection = {
  project: null,
  taskId: null,
  document: null,
  query: '',
  phase: 'all',
  source: '*',
  projects: ['*'],
  projectLimit: 16,
  catalogScroll: 0,
  boardScroll: 0
}
function owner(client: RpcClient): Owner {
  const generation = client.getGeneration?.() ?? 0
  const existing = owners.get(client)
  if (existing?.generation === generation) {
    return existing
  }
  const next: Owner = { generation, entries: new Map(), selections: new Map(), bytes: 0 }
  owners.set(client, next)
  return next
}
export function projectTaskCacheKey(
  hostId: string,
  kind: string,
  project?: string,
  id?: string,
  revision?: string,
  path?: string
): string {
  return JSON.stringify([hostId, kind, project, id, revision, path])
}
export function readProjectTaskPresentation(
  client: RpcClient | null,
  key: string,
  now = Date.now()
): ProjectTaskEntry | null {
  if (!client) {
    return null
  }
  const cache = owner(client)
  const saved = cache.entries.get(key)
  if (!saved) {
    return null
  }
  if (now - saved.at > 10 * 60_000) {
    cache.entries.delete(key)
    cache.bytes -= saved.bytes
    return null
  }
  cache.entries.delete(key)
  cache.entries.set(key, saved)
  return saved.value
}
export function projectTaskPresentationIsFresh(
  client: RpcClient,
  key: string,
  now = Date.now()
): boolean {
  const saved = owner(client).entries.get(key)
  return saved !== undefined && now - saved.at < 60_000
}
export function saveProjectTaskPresentation(
  client: RpcClient,
  key: string,
  value: ProjectTaskEntry,
  now = Date.now()
): void {
  const cache = owner(client)
  const previous = cache.entries.get(key)
  if (previous) {
    cache.entries.delete(key)
    cache.bytes -= previous.bytes
  }
  const bytes = JSON.stringify(value).length * 2
  if (bytes > 2 * 1024 * 1024) {
    return
  }
  cache.entries.set(key, { value, bytes, at: now })
  cache.bytes += bytes
  while (cache.entries.size > 24 || cache.bytes > 2 * 1024 * 1024) {
    const first = cache.entries.keys().next().value
    if (first === undefined) {
      break
    }
    const removed = cache.entries.get(first)
    cache.entries.delete(first)
    cache.bytes -= removed?.bytes ?? 0
  }
}
export function readProjectTaskSelection(
  client: RpcClient | null,
  hostId: string
): ProjectTaskSelection {
  return { ...EMPTY_SELECTION, ...(client ? owner(client).selections.get(hostId) : null) }
}
export function saveProjectTaskSelection(
  client: RpcClient,
  hostId: string,
  selection: ProjectTaskSelection
): void {
  const selections = owner(client).selections
  selections.delete(hostId)
  selections.set(hostId, selection)
  if (selections.size > 20) {
    const first = selections.keys().next().value
    if (first !== undefined) {
      selections.delete(first)
    }
  }
}
export function invalidateProjectTaskPresentation(
  client: RpcClient,
  hostId: string,
  project: string | null
): void {
  const cache = owner(client)
  for (const [key, saved] of cache.entries) {
    if (
      key.startsWith(`[${JSON.stringify(hostId)},`) &&
      (saved.value.kind === 'catalog' ? project === null : saved.value.project === project)
    ) {
      cache.entries.delete(key)
      cache.bytes -= saved.bytes
    }
  }
}
