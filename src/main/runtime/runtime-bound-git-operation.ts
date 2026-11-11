import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { GitPushTarget } from '../../shared/worktree/types'
import { boundGitLocalOperationForWorktree } from '../ipc/filesystem/git-remote/bound-git-local-operation'
import type { RuntimeGitTarget } from './runtime-git-command-target'
import type { RuntimeStore } from './runtime-store-contract'

export async function resolveRuntimeBoundGitOperation(
  store: RuntimeStore | null | undefined,
  target: RuntimeGitTarget,
  operation: 'fetch' | 'pull' | 'push',
  remoteName: string,
  pushTarget?: GitPushTarget
) {
  if (target.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  if (!store) {
    throw new Error('runtime_unavailable')
  }
  return boundGitLocalOperationForWorktree(store, {
    operation,
    requestedPath: target.worktree.path,
    resolvedPath: target.worktree.path,
    worktreeId: target.worktree.id,
    remoteName,
    pushTarget
  })
}
