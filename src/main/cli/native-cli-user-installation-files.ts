import { constants } from 'node:fs'
import { lstat, open, mkdir, realpath, link, unlink, rmdir } from 'node:fs/promises'
import { dirname, relative, resolve, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import {
  readEntrySnapshot,
  hasSameSnapshot,
  hasSameIdentity,
  quarantineCommandPath,
  capturedExpectedEntry,
  type EntrySnapshot
} from './cli-command-filesystem-transaction'
import { bestEffortFsyncDirectorySync } from '../../shared/secure-file'

export const NATIVE_USER_FILE_LIMIT = 1024 * 1024
export type NativeUserFile = {
  bytes: Buffer
  sha256: string
  mode: number
  snapshot: EntrySnapshot
}
export const nativeUserDigest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
export const nativeUserInside = (root: string, path: string) => {
  const part = relative(root, path)
  return (
    part !== '' &&
    part !== '..' &&
    !part.startsWith(`..${sep}`) &&
    !resolve(path).includes('\0') &&
    !part.startsWith(sep)
  )
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
export async function nativeUserFile(path: string): Promise<NativeUserFile | null> {
  const before = await readEntrySnapshot(path)
  if (!before) {
    return null
  }
  const info = await lstat(path)
  if (
    before.isSymbolicLink ||
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size > NATIVE_USER_FILE_LIMIT ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0 ||
    (info.mode & 0o600) !== 0o600
  ) {
    throw new Error('A native launcher target is not an owned writable regular file.')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = await file.stat({ bigint: true })
    if (
      actual.dev !== before.identity.dev ||
      actual.ino !== before.identity.ino ||
      actual.size > BigInt(NATIVE_USER_FILE_LIMIT)
    ) {
      throw new Error('A native launcher file changed during inspection.')
    }
    const buffer = Buffer.alloc(NATIVE_USER_FILE_LIMIT + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length)
      if (read.bytesRead === 0) {
        break
      }
      length += read.bytesRead
    }
    const bytes = buffer.subarray(0, length)
    if (
      bytes.length > NATIVE_USER_FILE_LIMIT ||
      !hasSameSnapshot(before, await readEntrySnapshot(path))
    ) {
      throw new Error('A native launcher file changed during inspection.')
    }
    return { bytes, sha256: nativeUserDigest(bytes), mode: info.mode & 0o777, snapshot: before }
  } finally {
    await file.close()
  }
}
export async function nativeUserDirectory(
  root: string,
  directory: string,
  create: boolean
): Promise<void> {
  if (directory !== root && !nativeUserInside(root, directory)) {
    throw new Error('Native launcher paths must stay inside the configured home.')
  }
  const parts = directory === root ? [] : relative(root, directory).split(sep)
  if (parts.length > 32) {
    throw new Error('Native launcher directory depth exceeds its bound.')
  }
  let current = root
  for (const part of ['', ...parts]) {
    if (part) {
      current = join(current, part)
    }
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (!missing(error) || !create || current === root) {
        throw error
      }
      await mkdir(current, { mode: 0o700 })
      info = await lstat(current)
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      (info.mode & 0o700) !== 0o700 ||
      (await realpath(current)) !== current
    ) {
      throw new Error(
        'Native launcher parent directories must be owned, writable and free of symlinks.'
      )
    }
  }
}
export async function writeNativeUserPrivate(
  path: string,
  bytes: string | Buffer,
  mode = 0o600
): Promise<void> {
  const file = await open(path, 'wx', mode)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  bestEffortFsyncDirectorySync(dirname(path))
}
async function restoreCaptured(held: string, path: string, snapshot: EntrySnapshot): Promise<void> {
  const current = await readEntrySnapshot(held)
  if (!current || !hasSameIdentity(current.identity, snapshot.identity)) {
    throw new Error('The displaced launcher entry changed; recovery is required.')
  }
  await link(held, path)
  await unlink(held)
}

/** Quarantine then publish without overwriting an entry created after the inspection. */
export async function replaceNativeUserFile(options: {
  home: string
  path: string
  before: NativeUserFile | null
  after: { bytes: Buffer; mode: number } | null
  assertExclusive: () => void
}): Promise<NativeUserFile | null> {
  const { path, before, after } = options
  await nativeUserDirectory(options.home, dirname(path), true)
  const parent = await readEntrySnapshot(dirname(path))
  options.assertExclusive()
  const captured = await quarantineCommandPath(path)
  let published: EntrySnapshot | null = null
  const staged = join(captured.directoryPath, 'publish')
  try {
    const same =
      captured.snapshot === null
        ? before === null
        : before !== null &&
          (await capturedExpectedEntry(captured, {
            snapshot: before.snapshot,
            fileSha256: null,
            rawSymlinkTarget: null
          })) &&
          captured.snapshot.identity.mode === before.snapshot.identity.mode
    if (!same) {
      throw new Error('The native launcher target changed before publication.')
    }
    if (before && (await nativeUserFile(captured.heldPath))?.sha256 !== before.sha256) {
      throw new Error('The native launcher target contents changed before publication.')
    }
    if (
      !hasSameIdentity(
        parent?.identity ?? null,
        (await readEntrySnapshot(dirname(path)))?.identity ?? null
      )
    ) {
      throw new Error('The native launcher parent changed before publication.')
    }
    options.assertExclusive()
    if (after) {
      await writeNativeUserPrivate(staged, after.bytes, after.mode)
      await link(staged, path)
      published = await readEntrySnapshot(path)
      if (!published) {
        throw new Error('Native launcher publication is unverifiable.')
      }
      await unlink(staged)
      published = await readEntrySnapshot(path)
    }
    await nativeUserDirectory(options.home, dirname(path), false)
    if (
      !hasSameIdentity(
        parent?.identity ?? null,
        (await readEntrySnapshot(dirname(path)))?.identity ?? null
      )
    ) {
      throw new Error('The native launcher parent changed during publication.')
    }
  } catch (error) {
    if (published) {
      const current = await readEntrySnapshot(path)
      if (!current || !hasSameSnapshot(current, published)) {
        throw new Error(
          'Native launcher recovery refused a changed publication; private backups are retained.',
          { cause: error }
        )
      }
      await unlink(path)
    }
    try {
      if (captured.snapshot) {
        await restoreCaptured(captured.heldPath, path, captured.snapshot)
      }
      await unlink(staged).catch((cause) => {
        if (!missing(cause)) {
          throw cause
        }
      })
      await rmdir(captured.directoryPath)
    } catch (cause) {
      throw new Error(
        `Native launcher recovery requires the preserved entry at ${captured.heldPath}.`,
        { cause }
      )
    }
    throw error
  }
  if (captured.snapshot) {
    await unlink(captured.heldPath)
  }
  await rmdir(captured.directoryPath)
  bestEffortFsyncDirectorySync(dirname(path))
  const result = await nativeUserFile(path)
  if (
    (after === null) !== (result === null) ||
    (result &&
      after &&
      (result.sha256 !== nativeUserDigest(after.bytes) || result.mode !== after.mode))
  ) {
    throw new Error('The native launcher publication changed before its proof was recorded.')
  }
  return result
}
