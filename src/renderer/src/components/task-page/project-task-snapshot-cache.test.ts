import { expect, it } from 'vitest'
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
