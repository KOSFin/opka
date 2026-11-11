import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as fsPromisesModule from 'node:fs/promises'

const read = vi.hoisted(() => vi.fn())
const close = vi.hoisted(() => vi.fn())
const zeroIdentity = vi.hoisted(() => ({ enabled: false }))
const handles = vi.hoisted(() => ({ open: 0, peak: 0 }))
const openDelay = vi.hoisted((): { gate?: Promise<void>; entered: number } => ({ entered: 0 }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  opendir: async () => {
    openDelay.entered++
    if (openDelay.gate) {
      await openDelay.gate
    }
    handles.open++
    handles.peak = Math.max(handles.peak, handles.open)
    return {
      read,
      close: async () => {
        await close()
        handles.open--
      }
    }
  },
  stat: async (path: string) => {
    const actual = await original<typeof fsPromisesModule>()
    const info = await actual.stat(path, { bigint: true })
    if (zeroIdentity.enabled) {
      Object.defineProperty(info, 'dev', { value: 0n })
      Object.defineProperty(info, 'ino', { value: 0n })
    }
    return info
  }
}))

import { readBoundedFileExplorerDirectoryPage } from './file-explorer-directory-page'

let path: string
beforeEach(async () => {
  path = await mkdtemp(join(tmpdir(), 'orca-explorer-limit-'))
  read.mockReset()
  close.mockReset().mockResolvedValue(undefined)
  zeroIdentity.enabled = false
  handles.open = 0
  handles.peak = 0
  openDelay.gate = undefined
  openDelay.entered = 0
})
afterEach(async () => {
  await rm(path, { recursive: true, force: true })
})

function entry(name: string) {
  return {
    name,
    isDirectory: () => false,
    isSymbolicLink: () => false
  }
}

it('fails explicitly at the scanned-entry limit and closes the handle', async () => {
  read.mockImplementation(() => entry('same'))
  await expect(
    readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, { limit: 1 })
  ).rejects.toThrow('too many entries')
  expect(read.mock.calls.length).toBe(50_001)
  expect(close).toHaveBeenCalledOnce()
})

it('rejects an entry above the JSON reply budget and closes the handle', async () => {
  read.mockResolvedValueOnce(entry('x'.repeat(256 * 1024))).mockResolvedValueOnce(null)
  await expect(
    readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
  ).rejects.toThrow('too large')
  expect(close).toHaveBeenCalledOnce()
})

it('stops after 128 symlink resolutions and closes the handle', async () => {
  read.mockImplementation(() => ({
    name: 'link',
    isDirectory: () => false,
    isSymbolicLink: () => true
  }))
  await expect(
    readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
      followSymlinks: true
    })
  ).rejects.toThrow('too many symlinks')
  expect(read.mock.calls.length).toBe(129)
  expect(close).toHaveBeenCalledOnce()
})

it('accepts a complete first page with zero filesystem identity', async () => {
  zeroIdentity.enabled = true
  read.mockResolvedValueOnce(entry('a')).mockResolvedValueOnce(null)
  await expect(
    readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
  ).resolves.toMatchObject({ entries: [{ name: 'a' }], nextCursor: null })
  expect(close).toHaveBeenCalledOnce()
})

it('refuses an incomplete first page when filesystem identity is zero', async () => {
  zeroIdentity.enabled = true
  read
    .mockResolvedValueOnce(entry('a'))
    .mockResolvedValueOnce(entry('b'))
    .mockResolvedValueOnce(null)
  await expect(
    readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, { limit: 1 })
  ).rejects.toThrow('identity is unavailable')
  expect(close).toHaveBeenCalledOnce()
})

it('keeps actual open directory handles at four under a concurrent read barrier', async () => {
  let release!: () => void
  const gate = new Promise<null>((resolve) => {
    release = () => resolve(null)
  })
  read.mockImplementation(() => gate)
  const pending = Array.from({ length: 4 }, () =>
    readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
  )
  await vi.waitFor(() => expect(handles.open).toBe(4))
  await expect(
    readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
  ).rejects.toThrow('Too many directory page reads')
  expect(handles.peak).toBe(4)
  release()
  await Promise.all(pending)
  expect(handles.open).toBe(0)
})

it('retains the slot and handle until an aborted read settles and closes', async () => {
  let release!: () => void
  const gate = new Promise<null>((resolve) => {
    release = () => resolve(null)
  })
  read.mockImplementation(() => gate)
  const controller = new AbortController()
  const pending = readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
    signal: controller.signal
  })
  await vi.waitFor(() => expect(handles.open).toBe(1))
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(handles.open).toBe(1)
  release()
  await vi.waitFor(() => expect(handles.open).toBe(0))
  expect(close).toHaveBeenCalledOnce()
})

it('retains the handle while close is delayed beyond cancellation', async () => {
  let releaseClose!: () => void
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  read.mockResolvedValueOnce(null)
  close.mockImplementationOnce(() => closeGate)
  const controller = new AbortController()
  const pending = readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
    signal: controller.signal
  })
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(handles.open).toBe(1)
  releaseClose()
  await vi.waitFor(() => expect(handles.open).toBe(0))
})

it('reserves before a delayed open and closes a handle that arrives after abort', async () => {
  let releaseOpen!: () => void
  openDelay.gate = new Promise<void>((resolve) => {
    releaseOpen = resolve
  })
  read.mockResolvedValue(null)
  const controller = new AbortController()
  const pending = readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
    signal: controller.signal
  })
  await vi.waitFor(() => expect(openDelay.entered).toBe(1))
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  releaseOpen()
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(handles.open).toBe(0)
})
