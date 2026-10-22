import { BoundedMap } from '../../../../../../shared/bounded-map'
import type { GitBranchCompareResult } from '../../../../../../shared/git-diff-compare-types'

type CompareTiming = {
  endedAt: number
  duration: number
  head: string | null
  remote: string | null
}
const timings = new BoundedMap<string, CompareTiming>({ maxEntries: 512 })
type CompareRead = { result: GitBranchCompareResult; endedAt: number; duration: number }
const pending = new Map<string, Promise<CompareRead>>()
export function readBranchCompareTiming(key: string, head: string | null, remote: string | null) {
  const timing = timings.get(key)
  return timing &&
    (!head || head === timing.head) &&
    (!remote || !timing.remote || remote === timing.remote)
    ? timing
    : undefined
}
export const saveBranchCompareTiming = (key: string, value: CompareTiming) =>
  timings.set(key, value)
export async function loadBranchCompare(
  key: string,
  head: string | null,
  read: () => Promise<GitBranchCompareResult>
): Promise<CompareRead> {
  const active = pending.get(key)
  if (active) {
    const completed = await active
    const { result } = completed
    if (
      !head ||
      result.summary.status !== 'ready' ||
      result.summary.headOid === head ||
      (head === '(initial)' && !result.summary.headOid)
    ) {
      return completed
    }
    return loadBranchCompare(key, head, read)
  }
  const startedAt = Date.now()
  const request = read()
    .then((result) => ({ result, endedAt: Date.now(), duration: Date.now() - startedAt }))
    .finally(() => {
      if (pending.get(key) === request) {
        pending.delete(key)
      }
    })
  pending.set(key, request)
  return request
}
export function clearBranchCompareTimingForTests() {
  timings.clear()
  pending.clear()
}
