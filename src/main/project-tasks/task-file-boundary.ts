import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  PROJECT_TASK_DOCUMENT_MAX_BYTES,
  PROJECT_TASK_CONFIG_PATH
} from '../../shared/project-task-contract'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import { pluginPathSegmentError } from '../../shared/plugins/plugin-path-safety'
import { taskRevision } from './task-document'

// SQLite's synchronous writer cannot await the async reader before committing.
export function readTaskTextSync(root: string, path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((part) => pluginPathSegmentError(part) !== null)
  ) {
    throw new Error('Invalid project-relative task path')
  }
  const canonical = realpathSync(root)
  const target = resolve(canonical, path)
  const offset = relative(canonical, target)
  if (offset.startsWith(`..${sep}`) || offset === '..' || target === canonical) {
    throw new Error('Task path escapes project')
  }
  let current = canonical
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const info = lstatSync(current)
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      throw new Error('Task paths must not traverse symlinks or non-directories')
    }
  }
  const file = openSync(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const info = fstatSync(file)
    if (!info.isFile() || info.size > PROJECT_TASK_DOCUMENT_MAX_BYTES) {
      throw new Error('Task document must be a regular file of at most 256 KiB')
    }
    const buffer = Buffer.alloc(info.size + 1)
    let count = 0
    while (count < buffer.length) {
      const bytes = readSync(file, buffer, count, buffer.length - count, count)
      if (!bytes) {
        break
      }
      count += bytes
    }
    const after = fstatSync(file)
    if (
      count !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ino !== info.ino
    ) {
      throw new Error('Task file changed during read; retry after saving')
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))
  } finally {
    closeSync(file)
  }
}

export function verifyTaskFileBoundary(
  root: string,
  configRevision: string,
  tasks: ProjectTaskEntry[]
): void {
  if (
    realpathSync(root) !== root ||
    taskRevision(readTaskTextSync(root, PROJECT_TASK_CONFIG_PATH)) !== configRevision
  ) {
    throw new Error('Project root or configuration changed; re-read before acting')
  }
  for (const task of tasks) {
    if (taskRevision(readTaskTextSync(root, task.path)) !== task.revision) {
      throw new Error('Task revision conflict; re-read before acting')
    }
  }
}
