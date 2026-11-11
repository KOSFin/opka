import { expect, it, vi } from 'vitest'
import { TaskSnapshotCache } from './project-task-snapshot-cache'

it('retains a snapshot across remounts, deduplicates concurrent checks, and revalidates instead of trusting cached state', async () => {
  const cache = new TaskSnapshotCache<string>()
  let calls = 0
  const read = async () => {
    calls++
    return 'first'
  }
  const one = cache.load('host/project', read)
  expect(cache.load('host/project', read)).toBe(one)
  await one
  expect(calls).toBe(1)
  expect(cache.peek('host/project')).toBe('first')
  const refresh = cache.load('host/project', async () => 'changed by another client')
  expect(cache.peek('host/project')).toBe('first')
  await refresh
  expect(cache.peek('host/project')).toBe('changed by another client')
  await expect(
    cache.load('host/project', async () => {
      throw new Error('offline')
    })
  ).rejects.toThrow('offline')
  expect(cache.peek('host/project')).toBe('changed by another client')
  expect(cache.peek('other-host/project')).toBeUndefined()
})

it('bounds retained bytes and entries, including one oversized response', async () => {
  const cache = new TaskSnapshotCache<string>(32, 2)
  await cache.load('one', async () => 'one')
  await cache.load('two', async () => 'two')
  await cache.load('three', async () => 'three')
  expect(cache.peek('one')).toBeUndefined()
  await cache.load('huge', async () => 'x'.repeat(100))
  expect(cache.peek('huge')).toBeUndefined()
  expect(cache.peek('two')).toBe('two')
})

it('expires old presentation and prevents an invalidated read from restoring it', async () => {
  const cache = new TaskSnapshotCache<string>(32, 2, 1_000)
  vi.useFakeTimers()
  try {
    vi.setSystemTime(1_000)
    await cache.load('host/project', async () => 'first')
    expect(cache.peek('host/project', 1_999)).toBe('first')
    expect(cache.peek('host/project', 2_000)).toBeUndefined()

    let finishOld: ((value: string) => void) | undefined
    const old = cache.load(
      'host/project',
      () =>
        new Promise<string>((resolve) => {
          finishOld = resolve
        })
    )
    cache.invalidate('host/project')
    const fresh = cache.load('host/project', async () => 'new host value')
    finishOld?.('stale host value')
    await Promise.all([old, fresh])
    expect(cache.peek('host/project')).toBe('new host value')
  } finally {
    vi.useRealTimers()
  }
})
