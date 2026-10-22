import { useCallback } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitBranchCompare } from '@/runtime/runtime-git-diff-client'
import { useAppStore } from '@/store'
import { createLoadingBranchCompareSummary } from '@/store/slices/editor/git/branch-compare-state'
import { loadBranchCompare, saveBranchCompareTiming } from './branch-compare-freshness'

export type BranchCompareRefreshKind = 'immediate' | 'interval'

export function useBranchCompareRead({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  branchName,
  timingKey,
  activeGitStatusHead,
  remoteSignature
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  isFolder: boolean
  branchName: string
  timingKey: string
  activeGitStatusHead: string | null
  remoteSignature: string | null
}) {
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  return useCallback(
    async (kind: BranchCompareRefreshKind) => {
      if (!activeWorktreeId || !worktreePath || !compareBaseRef || isFolder) {
        return
      }
      const requestKey = `${activeWorktreeId}:${compareBaseRef}:${Date.now()}`
      const summary = useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId]
      beginGitBranchCompareRequest(activeWorktreeId, requestKey, compareBaseRef, {
        preserveExistingSummary: !!summary && summary.baseRef === compareBaseRef
      })
      try {
        const { result, endedAt, duration } = await loadBranchCompare(
          timingKey,
          activeGitStatusHead,
          () =>
            getRuntimeGitBranchCompare(
              {
                target: requireGitOwnerTarget(activeRepoTarget),
                worktreeId: activeWorktreeId,
                worktreePath,
                connectionId: getConnectionId(activeWorktreeId) ?? undefined
              },
              compareBaseRef,
              kind === 'interval' ? 'background' : 'interactive'
            )
        )
        saveBranchCompareTiming(timingKey, {
          endedAt,
          duration,
          head: result.summary.headOid ?? activeGitStatusHead,
          remote: remoteSignature
        })
        setGitBranchCompareResult(activeWorktreeId, requestKey, result)
      } catch (error) {
        setGitBranchCompareResult(activeWorktreeId, requestKey, {
          summary: {
            ...createLoadingBranchCompareSummary(compareBaseRef),
            compareRef: branchName,
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'Branch compare failed'
          },
          entries: []
        })
      }
    },
    [
      activeRepoTarget,
      activeGitStatusHead,
      activeWorktreeId,
      beginGitBranchCompareRequest,
      branchName,
      compareBaseRef,
      isFolder,
      setGitBranchCompareResult,
      timingKey,
      remoteSignature,
      worktreePath
    ]
  )
}
