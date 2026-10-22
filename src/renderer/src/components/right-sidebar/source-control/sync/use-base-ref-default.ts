import { useEffect, useState } from 'react'
import { getRuntimeRepoBaseRefDefault } from '@/runtime/runtime-repo-client'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { BASE_REF_FRESH_MS, loadBaseRefSnapshot, readBaseRefSnapshot } from './base-ref-snapshots'

export function useSourceControlBaseRefDefault({
  activeRepoConnectionId,
  activeRepoExecutionHostId,
  activeRepoId,
  activeRepoPath,
  isBranchVisible,
  isFolder
}: {
  activeRepoConnectionId: string | null
  activeRepoExecutionHostId: ExecutionHostId | null
  activeRepoId: string | null
  activeRepoPath?: string | null
  isBranchVisible: boolean
  isFolder: boolean
}): string | null {
  const key = JSON.stringify([
    activeRepoExecutionHostId,
    activeRepoConnectionId,
    activeRepoId,
    activeRepoPath
  ])
  const cached = readBaseRefSnapshot(key)
  const [resolved, setResolved] = useState({ key, value: cached?.value ?? null })
  useEffect(() => {
    if (!isBranchVisible || !activeRepoId || !activeRepoExecutionHostId || isFolder) {
      return
    }
    const snapshot = readBaseRefSnapshot(key)
    if (snapshot && Date.now() - snapshot.checkedAt < BASE_REF_FRESH_MS) {
      setResolved({ key, value: snapshot.value })
      return
    }
    let stale = false
    // Why: resolved on the repo's OWNER host, not the focused runtime.
    void loadBaseRefSnapshot(
      key,
      async () =>
        (await getRuntimeRepoBaseRefDefault(activeRepoExecutionHostId, activeRepoId)).defaultBaseRef
    )
      .then((result) => {
        if (!stale) {
          setResolved({ key, value: result })
        }
      })
      .catch((err) => {
        console.error('[SourceControl] getBaseRefDefault failed', err)
        // Keep the same owner's last result on a failed revalidation; never invent a base.
      })
    return () => {
      stale = true
    }
  }, [
    // Why: only repo/host ownership changes should reset the base; unrelated metadata churn must not restart eligibility's timeout.
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    isBranchVisible,
    isFolder,
    key
  ])
  return resolved.key === key ? resolved.value : (cached?.value ?? null)
}
