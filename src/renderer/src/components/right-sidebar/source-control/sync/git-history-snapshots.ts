import { BoundedMap } from '../../../../../../shared/bounded-map'
import type { GitHistoryResult } from '../../../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'

type HistorySnapshot = { result: GitHistoryResult; checkedAt: number }
const sizeOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const snapshots = new BoundedMap<string, HistorySnapshot>({
  maxEntries: 128,
  maxBytes: 16 * 1024 * 1024,
  sizeOf
})
const files = new BoundedMap<string, GitBranchChangeEntry[]>({
  maxEntries: 1024,
  maxBytes: 16 * 1024 * 1024,
  sizeOf
})
const pending = new Map<string, Promise<GitHistoryResult>>()
export const GIT_HISTORY_SNAPSHOT_FRESH_MS = 30_000
export const readGitHistorySnapshot = (key: string) => snapshots.get(key)
export function loadGitHistorySnapshot(
  key: string,
  read: () => Promise<GitHistoryResult>,
  replacePending = false
): Promise<GitHistoryResult> {
  const active = pending.get(key)
  if (active && !replacePending) {
    return active
  }
  const request = read()
    .then((result) => {
      if (pending.get(key) === request) {
        snapshots.set(key, { result, checkedAt: Date.now() })
      }
      return result
    })
    .finally(() => {
      if (pending.get(key) === request) {
        pending.delete(key)
      }
    })
  pending.set(key, request)
  return request
}
export const readGitHistoryFiles = (scope: string, oid: string) =>
  files.get(JSON.stringify([scope, oid]))
export const saveGitHistoryFiles = (scope: string, oid: string, entries: GitBranchChangeEntry[]) =>
  files.set(JSON.stringify([scope, oid]), entries)
export function clearGitHistorySnapshotsForTests() {
  snapshots.clear()
  files.clear()
  pending.clear()
}
export function forgetGitHistorySnapshot(key: string) {
  snapshots.delete(key)
  pending.delete(key)
}
