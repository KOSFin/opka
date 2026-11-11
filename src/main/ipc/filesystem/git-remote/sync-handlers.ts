import { ipcMain } from 'electron'
import type {
  GitForkSyncExpectedUpstream,
  GitForkSyncResult
} from '../../../../shared/git-fork-sync'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { GitUpstreamStatus } from '../../../../shared/git-status-types'
import { gitFetch } from '../../../git/remote'
import { gitSyncForkDefaultBranch } from '../../../git/fork-sync'
import { getUpstreamStatus } from '../../../git/upstream'
import { validateGitPushTarget } from '../../../git/push-target-validation'
import { resolveRegisteredWorktreePath } from '../../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../local-worktree-runtime-options'
import { validateGitForkSyncExpectedUpstream } from '../../../../shared/git-fork-sync'
import { ipcGitWorktreeTarget, materializeWorktreePushTargetRemote } from '../../worktree-remote'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import {
  assertNoBoundGitProfileForUnsupportedOperation,
  boundGitLocalOperationForWorktree
} from './bound-git-local-operation'

export function registerGitRemoteSyncHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'git:upstreamStatus',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; pushTarget?: GitPushTarget }
    ): Promise<GitUpstreamStatus> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getUpstreamStatus(worktreePath, args.pushTarget, gitOptions)
    }
  )

  ipcMain.handle(
    'git:fetch',
    async (
      _event,
      args: {
        worktreePath: string
        worktreeId?: string
        connectionId?: string
        pushTarget?: GitPushTarget
      }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const localOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      const boundOperation = await boundGitLocalOperationForWorktree(store, {
        operation: 'fetch',
        requestedPath: args.worktreePath,
        resolvedPath: worktreePath,
        worktreeId: args.worktreeId,
        remoteName: args.pushTarget?.remoteName ?? 'origin',
        pushTarget: args.pushTarget
      })
      const gitOptions = { ...localOptions, ...(boundOperation ? { boundOperation } : {}) }
      const materializedPushTarget = args.pushTarget
        ? await materializeWorktreePushTargetRemote(
            worktreePath,
            args.pushTarget,
            store,
            undefined,
            gitOptions,
            ipcGitWorktreeTarget(args)
          )
        : undefined
      if (materializedPushTarget) {
        await validateGitPushTarget(worktreePath, materializedPushTarget, {
          ...gitOptions,
          admissionTier: 'interactive'
        })
      }
      await gitFetch(worktreePath, materializedPushTarget, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:syncFork',
    async (
      _event,
      args: {
        worktreePath: string
        connectionId?: string
        expectedUpstream: GitForkSyncExpectedUpstream
      }
    ): Promise<GitForkSyncResult> => {
      const expectedUpstream = validateGitForkSyncExpectedUpstream(args.expectedUpstream, {
        required: true
      })
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      await assertNoBoundGitProfileForUnsupportedOperation(store, args.worktreePath, worktreePath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return gitSyncForkDefaultBranch(worktreePath, expectedUpstream, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}
