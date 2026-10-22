import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { PROJECT_TASK_DOCUMENT_MAX_BYTES } from '../../shared/project-task-contract'
import { pluginPathSegmentError } from '../../shared/plugins/plugin-path-safety'

export function isTaskFileMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function taskFilePath(
  root: string,
  path: string,
  createParents = false
): Promise<string> {
  if (
    !path ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((part) => pluginPathSegmentError(part) !== null)
  ) {
    throw new Error('Invalid project-relative task path')
  }
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, path)
  if (relative(canonicalRoot, target).startsWith(`..${sep}`) || target === canonicalRoot) {
    throw new Error('Task path escapes project')
  }
  const parts = path.split('/')
  let current = canonicalRoot
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const parent = index < parts.length - 1
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (parent && !info.isDirectory())) {
        throw new Error('Task paths must not traverse symlinks or non-directories')
      }
    } catch (error) {
      if (!isTaskFileMissing(error)) {
        throw error
      }
      if (parent && createParents) {
        await mkdir(current, { mode: 0o755 }).catch(async (mkdirError) => {
          const info = await lstat(current).catch(() => null)
          if (!info?.isDirectory() || info.isSymbolicLink()) {
            throw mkdirError
          }
        })
      }
    }
  }
  return target
}

export async function readTaskText(root: string, path: string): Promise<string> {
  const target = await taskFilePath(root, path)
  if (!(await lstat(target)).isFile()) {
    throw new Error('Task document must be a regular file')
  }
  const file = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > PROJECT_TASK_DOCUMENT_MAX_BYTES) {
      throw new Error('Task document must be a regular file of at most 256 KiB')
    }
    const buffer = Buffer.alloc(Math.min(info.size + 1, PROJECT_TASK_DOCUMENT_MAX_BYTES + 1))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!result.bytesRead) {
        break
      }
      bytesRead += result.bytesRead
    }
    if (bytesRead > PROJECT_TASK_DOCUMENT_MAX_BYTES) {
      throw new Error('Task document exceeds 256 KiB')
    }
    const after = await file.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || bytesRead !== info.size) {
      throw new Error('Task file changed during read; retry after saving')
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}
