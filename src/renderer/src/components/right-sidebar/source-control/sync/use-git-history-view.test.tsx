// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { deferred, mountProbe, unmountProbes } from '../../source-control-hook-test-harness'
import { clearSourceControlViewsForTests } from '../panel/source-control-view-memory'
import { clearGitHistorySnapshotsForTests } from './git-history-snapshots'
import { useGitHistoryView } from './use-git-history-view'
import type { GitHistoryResult } from '../../../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'

const item = { id: 'same-oid', subject: 'Commit', message: 'Commit', parentIds: [] }
const result: GitHistoryResult = {
  items: [item],
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  hasMore: false,
  limit: 50
}
const files: GitBranchChangeEntry[] = [{ path: 'web.ts', status: 'modified' }]
let latest: ReturnType<typeof useGitHistoryView>
const load = vi.fn<() => Promise<GitBranchChangeEntry[]>>()
function Probe({ owner = 'web', data = result }: { owner?: string; data?: GitHistoryResult }) {
  latest = useGitHistoryView(owner, data, false, load)
  return null
}
beforeEach(() => {
  clearSourceControlViewsForTests()
  clearGitHistorySnapshotsForTests()
  load.mockReset().mockResolvedValue(files)
})
afterEach(unmountProbes)

it('retains expanded commit files across refresh and keyed panel remount', async () => {
  const root = await mountProbe(<Probe />)
  await act(async () => {
    latest.handleToggleExpand(item)
  })
  expect(latest.expanded.has(item.id)).toBe(true)
  expect(latest.filesByCommit[item.id]).toEqual({ status: 'ready', entries: files })
  await act(async () => {
    root.render(<Probe data={{ ...result }} />)
  })
  await act(async () => {
    root.render(<Probe key="backend" owner="backend" />)
  })
  expect(latest.expanded.size).toBe(0)
  await act(async () => {
    root.render(<Probe key="web" />)
  })
  expect(latest.expanded.has(item.id)).toBe(true)
  expect(latest.filesByCommit[item.id]).toEqual({ status: 'ready', entries: files })
  expect(load).toHaveBeenCalledTimes(1)
})

it('does not deliver an old owner file response into a new scope with the same oid', async () => {
  const pending = deferred<GitBranchChangeEntry[]>()
  load.mockReturnValueOnce(pending.promise)
  const root = await mountProbe(<Probe />)
  await act(async () => {
    latest.handleToggleExpand(item)
  })
  await act(async () => {
    root.render(<Probe owner="remote" />)
  })
  await act(async () => {
    pending.resolve(files)
  })
  expect(latest.expanded.size).toBe(0)
  expect(latest.filesByCommit[item.id]).toBeUndefined()
})

it('uses immutable files immediately when history arrives after the first render', async () => {
  const root = await mountProbe(<Probe />)
  await act(async () => {
    latest.handleToggleExpand(item)
  })
  await act(async () => {
    root.render(<Probe key="remount" data={{ ...result, items: [] }} />)
  })
  await act(async () => {
    root.render(<Probe key="remount" />)
  })
  expect(latest.filesByCommit[item.id]).toEqual({ status: 'ready', entries: files })
  expect(load).toHaveBeenCalledTimes(1)
})
