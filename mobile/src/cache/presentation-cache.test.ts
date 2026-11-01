import { afterEach, expect, it, vi } from 'vitest'
import {
  forgetCachedWorktrees,
  getCachedWorktrees,
  getProvenCachedWorktrees,
  getRetainedWorktrees,
  setCachedWorktrees
} from './worktree-cache'
import { forgetCachedRepos, getCachedRepos, getRetainedRepos, setCachedRepos } from './repo-cache'

afterEach(() => vi.useRealTimers())
it('retains display rows without extending authoritative absence evidence', () => {
  vi.useFakeTimers()
  const rows = [{ worktreeId: 'existing-work' }]
  setCachedWorktrees('retained-work', rows, { proven: true })
  vi.advanceTimersByTime(60_001)
  expect(getCachedWorktrees('retained-work')).toBeNull()
  expect(getProvenCachedWorktrees('retained-work')).toBeNull()
  expect(getRetainedWorktrees('retained-work')).toEqual(rows)
  vi.advanceTimersByTime(10 * 60_000)
  expect(getRetainedWorktrees('retained-work')).toBeNull()
})
it('retains repo picker rows while a new list revalidates', () => {
  vi.useFakeTimers()
  setCachedRepos('retained-repo', [{ id: 'repo' }])
  vi.advanceTimersByTime(60_001)
  expect(getCachedRepos('retained-repo')).toBeNull()
  expect(getRetainedRepos('retained-repo')).toEqual([{ id: 'repo' }])
})
it('forgets only the removed owner and bounds retained owner entries', () => {
  setCachedWorktrees('owner-a', [{ worktreeId: 'a' }])
  setCachedWorktrees('owner-b', [{ worktreeId: 'b' }])
  setCachedRepos('owner-a', [{ id: 'a' }])
  setCachedRepos('owner-b', [{ id: 'b' }])
  forgetCachedWorktrees('owner-a')
  forgetCachedRepos('owner-a')
  expect(getRetainedWorktrees('owner-a')).toBeNull()
  expect(getRetainedRepos('owner-a')).toBeNull()
  expect(getRetainedWorktrees('owner-b')).toEqual([{ worktreeId: 'b' }])
  expect(getRetainedRepos('owner-b')).toEqual([{ id: 'b' }])
  for (let i = 0; i < 30; i++) {
    setCachedWorktrees(`bounded-${i}`, [])
    setCachedRepos(`bounded-${i}`, [])
  }
  expect(getRetainedWorktrees('bounded-0')).toBeNull()
  expect(getRetainedRepos('bounded-0')).toBeNull()
  expect(getRetainedWorktrees('bounded-29')).toEqual([])
})

it('does not let a one-row home seed truncate a retained host-listed catalog', () => {
  vi.useFakeTimers()
  const rows = [{ worktreeId: 'first' }, { worktreeId: 'second' }]
  setCachedWorktrees('retained-complete', rows, { proven: true })
  vi.advanceTimersByTime(60_001)
  setCachedWorktrees('retained-complete', [{ worktreeId: 'first' }])
  expect(getRetainedWorktrees('retained-complete')).toEqual(rows)
  expect(getProvenCachedWorktrees('retained-complete')).toBeNull()
})
