import { BoundedMap } from '../../../../../../shared/bounded-map'

export const BASE_REF_FRESH_MS = 30_000
const snapshots = new BoundedMap<string, { value: string | null; checkedAt: number }>({
  maxEntries: 256
})
const pending = new Map<string, Promise<string | null>>()
export const readBaseRefSnapshot = (key: string) => snapshots.get(key)
export function loadBaseRefSnapshot(key: string, read: () => Promise<string | null>) {
  const active = pending.get(key)
  if (active) {
    return active
  }
  const request = read()
    .then((value) => {
      snapshots.set(key, { value, checkedAt: Date.now() })
      return value
    })
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}
export function clearBaseRefSnapshotsForTests() {
  snapshots.clear()
  pending.clear()
}
