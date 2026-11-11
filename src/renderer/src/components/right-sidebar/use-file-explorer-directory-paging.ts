import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import type { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  fileExplorerEntriesToTreeNodes,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import { describeFileExplorerReadError } from './file-explorer-read-error'
import {
  clearFileExplorerDirsLoading,
  markFileExplorerDirsLoading
} from './file-explorer-dir-load-state'

export function useFileExplorerDirectoryPaging({
  activeWorktreeId,
  worktreePath,
  dirCacheRef,
  displayRootPathRef,
  loadingDirPathsRef,
  dirLoadTrackerRef,
  setDirCache,
  updateLoadingDirPaths
}: {
  activeWorktreeId?: string | null
  worktreePath: string | null
  dirCacheRef: RefObject<Record<string, DirCache>>
  displayRootPathRef: RefObject<string | null | undefined>
  loadingDirPathsRef: RefObject<ReadonlySet<string>>
  dirLoadTrackerRef: RefObject<ReturnType<typeof createFileExplorerDirLoadTracker>>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  updateLoadingDirPaths: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void
}): (dirPath: string, depth: number) => Promise<void> {
  return useCallback(
    async (dirPath: string, depth: number) => {
      const current = dirCacheRef.current[dirPath]
      if (!current?.nextCursor || loadingDirPathsRef.current.has(dirPath)) {
        return
      }
      const cursor = current.nextCursor
      const requestedDisplayRoot = displayRootPathRef.current
      const loadToken = dirLoadTrackerRef.current.begin(dirPath)
      updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, [dirPath]))
      try {
        const listing = await readFileExplorerDirectory(
          activeWorktreeId,
          worktreePath,
          dirPath,
          cursor
        )
        if (
          !dirLoadTrackerRef.current.isCurrent(loadToken) ||
          displayRootPathRef.current !== requestedDisplayRoot
        ) {
          return
        }
        setDirCache((prev) => {
          const cached = prev[dirPath]
          if (
            displayRootPathRef.current !== requestedDisplayRoot ||
            !cached ||
            cached.nextCursor !== cursor ||
            JSON.stringify(cached.operationOwner) !== JSON.stringify(listing.operationOwner)
          ) {
            return prev
          }
          return {
            ...prev,
            [dirPath]: {
              ...cached,
              children: [
                ...cached.children,
                ...fileExplorerEntriesToTreeNodes(
                  listing.entries,
                  dirPath,
                  depth,
                  worktreePath,
                  listing.operationOwner
                )
              ],
              nextCursor: listing.nextCursor,
              error: undefined
            }
          }
        })
      } catch (error) {
        if (
          dirLoadTrackerRef.current.isCurrent(loadToken) &&
          displayRootPathRef.current === requestedDisplayRoot
        ) {
          setDirCache((prev) => ({
            ...prev,
            [dirPath]: {
              ...prev[dirPath],
              children: prev[dirPath]?.children ?? [],
              error: describeFileExplorerReadError(error)
            }
          }))
        }
      } finally {
        if (dirLoadTrackerRef.current.isCurrent(loadToken)) {
          updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, [dirPath]))
        }
      }
    },
    [
      activeWorktreeId,
      dirCacheRef,
      dirLoadTrackerRef,
      displayRootPathRef,
      loadingDirPathsRef,
      setDirCache,
      updateLoadingDirPaths,
      worktreePath
    ]
  )
}
