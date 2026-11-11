import { describe, expect, it, vi } from 'vitest'

const readRuntimeDirectoryPage = vi.fn()
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  readRuntimeDirectoryPage: (...args: unknown[]) => readRuntimeDirectoryPage(...args)
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({ settings: null, connectionId: null }),
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved'
}))

import { readFileExplorerDirectory } from './file-explorer-directory-listing'

describe('readFileExplorerDirectory', () => {
  it('re-sorts backend order — remote-runtime and paired-web routes return the host order verbatim', async () => {
    readRuntimeDirectoryPage.mockResolvedValueOnce({
      entries: [
        { name: '100 - b.txt', isDirectory: false, isSymlink: false },
        { name: '9 - c.txt', isDirectory: false, isSymlink: false },
        { name: '10 - dir', isDirectory: true, isSymlink: false },
        { name: '99 - a.txt', isDirectory: false, isSymlink: false }
      ],
      nextCursor: null
    })

    const { entries } = await readFileExplorerDirectory('wt-1', '/w', '/w/dir')
    expect(entries.map((e) => e.name)).toEqual([
      '10 - dir',
      '9 - c.txt',
      '99 - a.txt',
      '100 - b.txt'
    ])
  })
})

it('preserves the host directory classification with default Quick Open preferences', async () => {
  readRuntimeDirectoryPage.mockResolvedValueOnce({
    entries: [{ name: 'linked', isDirectory: true, isSymlink: true }],
    nextCursor: null
  })
  const { entries } = await readFileExplorerDirectory('wt-1', '/w', '/w')
  expect(entries).toEqual([{ name: 'linked', isDirectory: true, isSymlink: true }])
  expect(readRuntimeDirectoryPage).toHaveBeenLastCalledWith(expect.anything(), '/w', {})
})
