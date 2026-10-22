// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred, flush, mountProbe, unmountProbes } from './source-control-hook-test-harness'
import { useSourceControlBaseRefDefault } from './source-control/sync/use-base-ref-default'
import {
  BASE_REF_FRESH_MS,
  clearBaseRefSnapshotsForTests
} from './source-control/sync/base-ref-snapshots'

const read = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-repo-client', () => ({ getRuntimeRepoBaseRefDefault: read }))
let value: string | null = null
function Probe({ repo = 'A', connection = null }: { repo?: string; connection?: string | null }) {
  value = useSourceControlBaseRefDefault({
    activeRepoId: repo,
    activeRepoConnectionId: connection,
    activeRepoExecutionHostId: 'local',
    isBranchVisible: true,
    isFolder: false
  })
  return null
}
afterEach(() => {
  unmountProbes()
  clearBaseRefSnapshotsForTests()
  vi.resetAllMocks()
  vi.useRealTimers()
})
it('reuses a resolved default synchronously without another owner read', async () => {
  read.mockResolvedValue({ defaultBaseRef: 'main' })
  await mountProbe(<Probe />)
  await flush()
  unmountProbes()
  await mountProbe(<Probe />)
  expect(value).toBe('main')
  expect(read).toHaveBeenCalledTimes(1)
})
it('coalesces pending reads and caches an explicitly absent default', async () => {
  const pending = deferred<{ defaultBaseRef: null }>()
  read.mockReturnValue(pending.promise)
  await mountProbe(<Probe />)
  await mountProbe(<Probe />)
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve({ defaultBaseRef: null }))
  unmountProbes()
  await mountProbe(<Probe />)
  expect(value).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
})
it('never shows another owner result and ignores its late response', async () => {
  const pending = deferred<{ defaultBaseRef: string }>()
  read.mockReturnValueOnce(pending.promise).mockResolvedValue({ defaultBaseRef: 'remote/main' })
  const root = await mountProbe(<Probe />)
  await act(async () => root.render(<Probe repo="B" connection="remote" />))
  await flush()
  expect(value).toBe('remote/main')
  await act(async () => pending.resolve({ defaultBaseRef: 'old/main' }))
  expect(value).toBe('remote/main')
})
it('revalidates expired data and keeps the same owner default when offline', async () => {
  vi.useFakeTimers()
  read.mockResolvedValueOnce({ defaultBaseRef: 'main' }).mockRejectedValue(new Error('offline'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await mountProbe(<Probe />)
  await flush()
  unmountProbes()
  vi.setSystemTime(Date.now() + BASE_REF_FRESH_MS + 1)
  await mountProbe(<Probe />)
  await flush()
  expect(value).toBe('main')
  expect(read).toHaveBeenCalledTimes(2)
  log.mockRestore()
})
