import type { DirCache } from './file-explorer-types'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'
import { statUserOpenedPath, type UserOpenedPathStat } from '@/lib/user-opened-local-path'

export function markFileExplorerCachePathAsDirectory(
  prev: Record<string, DirCache>,
  path: string
): Record<string, DirCache> {
  let changed = false
  const next: Record<string, DirCache> = {}
  for (const [dirPath, cache] of Object.entries(prev)) {
    let cacheChanged = false
    const children = cache.children.map((child) => {
      if (child.path !== path || child.isDirectory) {
        return child
      }
      changed = true
      cacheChanged = true
      return { ...child, isDirectory: true }
    })
    next[dirPath] = cacheChanged ? { ...cache, children } : cache
  }
  return changed ? next : prev
}

export async function statFileExplorerTreePath(
  activeWorktreeId: string | null | undefined,
  worktreePath: string | null,
  path: string
): Promise<UserOpenedPathStat> {
  const operationOwner = getFileExplorerOperationOwner(activeWorktreeId)
  const route = getFileExplorerOperationRoute(operationOwner)
  if (!route) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  return statUserOpenedPath(
    {
      target: route.target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: route.connectionId
    },
    path
  )
}
