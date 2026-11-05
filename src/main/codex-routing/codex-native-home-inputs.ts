import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readEntrySnapshot, hasSameSnapshot } from '../cli/cli-command-filesystem-transaction'

export const nativeHomeDigest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
export const nativeHomeMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
export async function readNativeHomeInput(
  path: string,
  maximum = 1024 * 1024
): Promise<Buffer | null> {
  let before
  try {
    before = await readEntrySnapshot(path)
  } catch (error) {
    if (nativeHomeMissing(error)) {
      return null
    }
    throw error
  }
  if (!before) {
    return null
  }
  const info = await lstat(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maximum ||
    (info.mode & 0o022) !== 0 ||
    info.uid !== process.getuid?.()
  ) {
    throw new Error('Native Codex input must be an owned bounded regular file.')
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await fd.stat({ bigint: true })
    if (current.dev !== before.identity.dev || current.ino !== before.identity.ino) {
      throw new Error('Native Codex input changed during preparation.')
    }
    const bytes = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await fd.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) {
        break
      }
      length += result.bytesRead
    }
    if (length > maximum || !hasSameSnapshot(before, await readEntrySnapshot(path))) {
      throw new Error('Native Codex input changed during preparation.')
    }
    return bytes.subarray(0, length)
  } finally {
    await fd.close()
  }
}
