// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerTree } from './useFileExplorerTree'

const read = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFileExplorerDirectory: read
}))
vi.mock('./file-explorer-operation-owner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({ kind: 'local' })
}))

const page = (name: string, nextCursor: string | null) => ({
  entries: [{ name, isDirectory: false }],
  nextCursor,
  operationOwner: { kind: 'local' }
})

beforeEach(() => read.mockReset())
afterEach(cleanup)

it('appends only a requested page and ignores a page superseded by refresh', async () => {
  read.mockResolvedValueOnce(page('one', 'cursor-1'))
  const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt'))
  await act(async () => {
    await result.current.loadDir('/repo', -1)
  })
  expect(read).toHaveBeenCalledTimes(1)
  let resolveSecond!: (value: ReturnType<typeof page>) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSecond = resolve
      })
  )
  let pending!: Promise<void>
  act(() => {
    pending = result.current.loadMoreDir('/repo', -1)
  })
  read.mockResolvedValueOnce(page('replacement', null))
  await act(async () => {
    await result.current.refreshDir('/repo')
  })
  await act(async () => {
    resolveSecond(page('stale', null))
    await pending
  })
  expect(result.current.dirCache['/repo'].children.map((entry) => entry.name)).toEqual([
    'replacement'
  ])
  expect(read).toHaveBeenCalledTimes(3)
})

it('appends a current page once and retains its cursor', async () => {
  read.mockResolvedValueOnce(page('one', 'cursor-1'))
  read.mockResolvedValueOnce(page('two', 'cursor-2'))
  const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt'))
  await act(async () => {
    await result.current.loadDir('/repo', -1)
  })
  await act(async () => {
    await result.current.loadMoreDir('/repo', -1)
  })
  expect(result.current.dirCache['/repo'].children.map((entry) => entry.name)).toEqual([
    'one',
    'two'
  ])
  expect(result.current.dirCache['/repo'].nextCursor).toBe('cursor-2')
  expect(read).toHaveBeenLastCalledWith('wt', '/repo', '/repo', 'cursor-1')
})
