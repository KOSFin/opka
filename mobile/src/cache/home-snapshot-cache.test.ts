import { afterEach, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.clearAllMocks()
})

it('expires a memory snapshot and refuses stale persisted usage after ten minutes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
  storage.setItem.mockResolvedValue(undefined)
  const cache = await import('./home-snapshot-cache')
  const snapshot = { worktreeInfo: {}, accountsByHost: {}, savedAt: Date.now() }
  cache.saveHomeSnapshot(snapshot)
  expect(await cache.loadHomeSnapshot()).toEqual(snapshot)
  vi.advanceTimersByTime(10 * 60_000 + 1)
  storage.getItem.mockResolvedValue(JSON.stringify(snapshot))
  expect(await cache.loadHomeSnapshot()).toBeNull()
})

it('bounds retained hosts and rejects oversized persisted snapshots', async () => {
  const cache = await import('./home-snapshot-cache')
  const hosts = Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [
      `host-${index}`,
      { hostId: `host-${index}`, totalWorktrees: 0, activeCount: 0, lastActiveWorktree: null }
    ])
  )
  cache.saveHomeSnapshot({ worktreeInfo: hosts, accountsByHost: {}, savedAt: Date.now() })
  const retained = await cache.loadHomeSnapshot()
  expect(Object.keys(retained?.worktreeInfo ?? {})).toHaveLength(20)
  expect(retained?.worktreeInfo).not.toHaveProperty('host-0')
  vi.resetModules()
  storage.getItem.mockResolvedValue('x'.repeat(1024 * 1024 + 1))
  const freshCache = await import('./home-snapshot-cache')
  expect(await freshCache.loadHomeSnapshot()).toBeNull()
})
