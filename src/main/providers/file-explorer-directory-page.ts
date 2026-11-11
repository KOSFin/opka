import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import type {
  FileExplorerDirectoryPage,
  FileExplorerDirectoryPageOptions
} from '../../shared/file-explorer-directory-page'
import { compareFileNames } from '../../shared/file-name-sort'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { classifyFilesystemDirectoryEntries } from '../ipc/filesystem-symlink-directory-entries'

const PAGE_LIMIT = 128
const SCAN_LIMIT = 50_000
const SCAN_TIMEOUT_MS = 3_000
const SYMLINK_LIMIT = 128
const MAX_ACTIVE_HANDLES = 4
const MAX_CURSOR_BYTES = 1_500
const MAX_REPLY_BYTES = 256 * 1024
const cursorKey = randomBytes(32)
let activeHandles = 0

const CursorSchema = z.object({
  version: z.literal(1),
  owner: z.string().length(64),
  stamp: z.string().min(1).max(300),
  last: z.object({ name: z.string().min(1).max(1024), isDirectory: z.boolean() })
})
type Cursor = z.infer<typeof CursorSchema>

function compareEntries(
  a: Pick<DirEntry, 'name' | 'isDirectory'>,
  b: Pick<DirEntry, 'name' | 'isDirectory'>
): number {
  return a.isDirectory === b.isDirectory ? compareFileNames(a.name, b.name) : a.isDirectory ? -1 : 1
}

function directoryStamp(info: BigIntStats): string | null {
  if (!info.isDirectory() || !info.dev || !info.ino) {
    return null
  }
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join(':')
}

function cursorOwner(selector: string, canonicalPath: string, followSymlinks: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify([selector, canonicalPath, followSymlinks]))
    .digest('hex')
}

function encodeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  const signature = createHmac('sha256', cursorKey).update(payload).digest('hex')
  return `${payload}.${signature}`
}

function decodeCursor(value: string, owner: string, stamp: string | null): Cursor {
  if (
    Buffer.byteLength(value) > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)
  ) {
    throw new Error('Invalid directory page cursor')
  }
  const separator = value.lastIndexOf('.')
  const payload = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  const expected = createHmac('sha256', cursorKey).update(payload).digest()
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
    throw new Error('Invalid directory page cursor')
  }
  const parsed = CursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  if (!stamp || parsed.owner !== owner || parsed.stamp !== stamp) {
    throw new Error('Directory changed; retry from the beginning')
  }
  return parsed
}

function checkScan(startedAt: number, scanned: number, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Directory page read cancelled')
  }
  if (scanned > SCAN_LIMIT || Date.now() - startedAt > SCAN_TIMEOUT_MS) {
    throw new Error('Directory has too many entries to list within the bounded scan')
  }
}

function insertCandidate(candidates: DirEntry[], entry: DirEntry, capacity: number): void {
  let low = 0
  let high = candidates.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (compareEntries(candidates[middle], entry) < 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  if (low >= capacity) {
    return
  }
  candidates.splice(low, 0, entry)
  if (candidates.length > capacity) {
    candidates.pop()
  }
}

export async function readBoundedFileExplorerDirectoryPage(
  dirPath: string,
  selector: string,
  authorize: (path: string) => Promise<string>,
  options: FileExplorerDirectoryPageOptions = {}
): Promise<FileExplorerDirectoryPage> {
  const limit = options.limit ?? PAGE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
    throw new Error('Invalid directory page limit')
  }
  if (selector.length > 512) {
    throw new Error('Invalid directory page owner')
  }
  if (activeHandles >= MAX_ACTIVE_HANDLES) {
    throw new Error('Too many directory page reads are active')
  }
  activeHandles++
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Directory page read cancelled'))
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) {
    cancel()
  }
  const timeout = setTimeout(
    () => controller.abort(new Error('Directory page read exceeded the time limit')),
    SCAN_TIMEOUT_MS
  )
  const startedAt = Date.now()
  const scan = async (): Promise<FileExplorerDirectoryPage> => {
    try {
      checkScan(startedAt, 0, controller.signal)
      const canonicalPath = await authorize(dirPath)
      checkScan(startedAt, 0, controller.signal)
      const initialInfo = await stat(canonicalPath, { bigint: true })
      checkScan(startedAt, 0, controller.signal)
      const initialStamp = directoryStamp(initialInfo)
      if (!initialInfo.isDirectory()) {
        throw new Error('Path is not a directory')
      }
      const followSymlinks = options.followSymlinks === true
      const owner = cursorOwner(selector, canonicalPath, followSymlinks)
      const cursor = options.cursor ? decodeCursor(options.cursor, owner, initialStamp) : null
      const candidates: DirEntry[] = []
      let scanned = 0
      let symlinks = 0
      const directory = await opendir(canonicalPath)
      try {
        checkScan(startedAt, scanned, controller.signal)
        for (;;) {
          checkScan(startedAt, scanned, controller.signal)
          const raw = await directory.read()
          checkScan(startedAt, scanned, controller.signal)
          if (!raw) {
            break
          }
          scanned++
          checkScan(startedAt, scanned, controller.signal)
          if (raw.isSymbolicLink() && followSymlinks && ++symlinks > SYMLINK_LIMIT) {
            throw new Error('Directory has too many symlinks to resolve in one page')
          }
          const entry: DirEntry =
            raw.isSymbolicLink() && followSymlinks
              ? (await classifyFilesystemDirectoryEntries(canonicalPath, [raw], true, authorize))[0]
              : {
                  name: raw.name,
                  isDirectory: raw.isDirectory(),
                  isSymlink: raw.isSymbolicLink()
                }
          checkScan(startedAt, scanned, controller.signal)
          if (Buffer.byteLength(JSON.stringify(entry)) > MAX_REPLY_BYTES) {
            throw new Error('Directory entry is too large for one page')
          }
          if (cursor && compareEntries(entry, cursor.last) <= 0) {
            continue
          }
          insertCandidate(candidates, entry, limit + 1)
        }
      } finally {
        await directory.close()
      }
      const canonicalAfter = await authorize(dirPath)
      checkScan(startedAt, scanned, controller.signal)
      const finalInfo = await stat(canonicalAfter, { bigint: true })
      const finalStamp = directoryStamp(finalInfo)
      checkScan(startedAt, scanned, controller.signal)
      if (
        canonicalAfter !== canonicalPath ||
        !finalInfo.isDirectory() ||
        (initialStamp && finalStamp !== initialStamp)
      ) {
        throw new Error('Directory changed; retry from the beginning')
      }
      const entries = candidates.slice(0, limit)
      const hasMore = candidates.length > limit
      if (!initialStamp && hasMore) {
        throw new Error('Directory identity is unavailable; cannot continue this listing safely')
      }
      const last = entries.at(-1)
      const nextCursor =
        hasMore && last && initialStamp
          ? encodeCursor({
              version: 1,
              owner,
              stamp: initialStamp,
              last: { name: last.name, isDirectory: last.isDirectory }
            })
          : null
      const result = { entries, nextCursor }
      if (
        Buffer.byteLength(JSON.stringify({ id: 'x', ok: true, result, _meta: {} })) >
        MAX_REPLY_BYTES
      ) {
        throw new Error('Directory page exceeds the reply budget')
      }
      return result
    } finally {
      activeHandles--
    }
  }
  try {
    return await waitForPromiseWithSignal(scan(), controller.signal)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}
