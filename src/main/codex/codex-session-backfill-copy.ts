import { copyFile, link, rm, writeFile, open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import {
  cleanupExitedCodexSessionStages,
  createCodexSessionStagingPath
} from './codex-session-staging'

const ATOMIC_NO_REPLACE_UNSUPPORTED_CODE = 'ORCA_ATOMIC_NO_REPLACE_UNSUPPORTED'

export async function copySessionFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string,
  options?: { cloneOnly?: boolean; maximumBytes?: number; recoverStages?: boolean }
): Promise<void> {
  if (options?.recoverStages !== false) {
    await cleanupExitedCodexSessionStages(dirname(targetPath))
  }
  const temporaryPath = createCodexSessionStagingPath(dirname(targetPath))
  // Why: stage cross-volume copies away from the rollout filename so a failed
  // copy cannot strand a truncated session that a later retry would skip.
  await writeFile(temporaryPath, '', { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  try {
    if (
      options?.maximumBytes !== undefined &&
      (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0)
    ) {
      throw new Error('Exclusive copy requires a nonnegative bounded size.')
    }
    if (options?.maximumBytes !== undefined && !options.cloneOnly) {
      await boundedCopy(sourcePath, temporaryPath, options.maximumBytes)
    } else {
      await (options?.cloneOnly
        ? copyFile(sourcePath, temporaryPath, constants.COPYFILE_FICLONE_FORCE)
        : copyFile(sourcePath, temporaryPath))
      if (
        options?.maximumBytes !== undefined &&
        (await stat(temporaryPath)).size > options.maximumBytes
      ) {
        throw new Error('Exclusive copy source exceeds its size bound.')
      }
    }
    try {
      // Why: this same-volume hardlink atomically installs the staged copy
      // without risking a collision overwrite after an EXDEV fallback.
      await link(temporaryPath, targetPath)
    } catch (installLinkError) {
      if (isExistsError(installLinkError)) {
        throw installLinkError
      }
      if (!isHardlinkUnsupportedError(installLinkError)) {
        throw installLinkError
      }
      // Why: Node has no portable atomic rename-if-absent. Fail closed on a
      // hardlink-less target instead of risking replacement of a concurrent file.
      throw makeAtomicNoReplaceUnsupportedError(targetPath, installLinkError)
    }
  } finally {
    try {
      await rm(temporaryPath, { force: true })
    } catch (error) {
      // Why: cleanup trouble must not misreport a successfully installed
      // rollout as a copy failure; the .tmp file is ignored by Codex.
      console.warn('[codex-session-backfill] Failed to remove staged copy:', temporaryPath, error)
    }
  }
}

async function boundedCopy(sourcePath: string, targetPath: string, maximum: number): Promise<void> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await source.stat()
    if (!info.isFile() || info.size > maximum) {
      throw new Error('Exclusive copy source exceeds its size bound.')
    }
    const target = await open(targetPath, 'r+')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      let length = 0
      while (true) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.length, maximum - length + 1),
          length
        )
        if (!bytesRead) {
          break
        }
        if (length + bytesRead > maximum) {
          throw new Error('Exclusive copy source exceeds its size bound.')
        }
        let offset = 0
        while (offset < bytesRead) {
          const result = await target.write(buffer, offset, bytesRead - offset, length + offset)
          if (!result.bytesWritten) {
            throw new Error('Exclusive copy could not complete its bounded write.')
          }
          offset += result.bytesWritten
        }
        length += bytesRead
      }
    } finally {
      await target.close()
    }
  } finally {
    await source.close()
  }
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function isHardlinkUnsupportedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOSYS'
  )
}

function makeAtomicNoReplaceUnsupportedError(
  targetPath: string,
  cause: unknown
): NodeJS.ErrnoException {
  const error = new Error(
    `Cannot atomically install backfill without overwrite on this filesystem: ${targetPath}`,
    { cause }
  ) as NodeJS.ErrnoException
  error.code = ATOMIC_NO_REPLACE_UNSUPPORTED_CODE
  return error
}

export function isAtomicNoReplaceUnsupportedError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === ATOMIC_NO_REPLACE_UNSUPPORTED_CODE
}
