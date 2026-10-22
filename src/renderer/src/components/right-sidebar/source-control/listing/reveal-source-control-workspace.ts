import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeTargetHostId } from '@/runtime/runtime-client-target'
import { getConnectionExecutionHostId } from '../../../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

export function revealSourceControlWorkspace(
  worktreeId: string,
  target: RuntimeClientTarget | null
): boolean {
  if (!target) {
    return false
  }
  const owner =
    target.kind === 'environment'
      ? getRuntimeTargetHostId(target)
      : getConnectionExecutionHostId(getConnectionId(worktreeId))
  const state = useAppStore.getState()
  if (
    state.activeWorktreeId === worktreeId &&
    (state.activeWorkspaceExecutionHostId ?? 'local') === owner
  ) {
    return true
  }
  // Opening a diff supplies its own surface, never a spare shell or default agent.
  return (
    activateAndRevealWorktree(worktreeId, {
      executionHostId: owner,
      providesInitialSurface: true
    }) !== false
  )
}
