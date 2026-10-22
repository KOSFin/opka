import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  getWorktreeExecutionHostId,
  getRepoExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import { toast } from 'sonner'

export async function getRepositoryMainWorkingCopy(repo: Repo) {
  const findMain = () =>
    useAppStore
      .getState()
      .worktreesByRepo[repo.id]?.find(
        (entry) =>
          entry.isMainWorktree &&
          getWorktreeExecutionHostId(entry, repo) === getRepoExecutionHostId(repo)
      )
  const existing = findMain()
  if (existing) {
    return existing
  }
  await useAppStore.getState().fetchWorktrees(repo.id)
  const main = findMain()
  if (!main) {
    throw new Error('The main working copy is unavailable. Reconnect this host and retry.')
  }
  return main
}

export function openRepositoryWorkingCopy(repo: Repo): void {
  const before = useAppStore.getState()
  const active = before.activeWorktreeId
  const host = before.activeWorkspaceExecutionHostId
  void getRepositoryMainWorkingCopy(repo)
    .then((main) => {
      const current = useAppStore.getState()
      if (current.activeWorktreeId !== active || current.activeWorkspaceExecutionHostId !== host) {
        return
      }
      activateAndRevealWorktree(main.id, {
        executionHostId: getRepoExecutionHostId(repo),
        navigationIntent: 'user-open'
      })
    })
    .catch((cause: unknown) =>
      toast.error(cause instanceof Error ? cause.message : 'Could not open repository')
    )
}
