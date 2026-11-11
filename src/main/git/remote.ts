import {
  normalizeGitErrorMessage,
  runPullWithDivergenceFallback
} from '../../shared/git-remote-error'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitNetworkOptionsForWorktree, gitOptionsForWorktree } from './git-runtime-options'
import {
  postponeRepoRefMaintenance,
  withRepoRefMaintenancePaused
} from './local-repo-ref-maintenance'
import { validateGitPushTarget } from './push-target-validation'
import { gitExecFileAsync } from './runner'
import { fetchForkRemoteWithStaleRefspecRepair } from './fork-remote-stale-branch-refspec'
import { runWithGitReadCacheInvalidation } from './status'
import { runWithGitWorktreeOperationLock } from '../../shared/git-worktree-operation-lock'

export { gitPullRebaseFromBase } from './remote-rebase'

function explicitPushTarget(target: GitPushTarget): { remote: string; refspec: string } {
  return { remote: target.remoteName, refspec: `HEAD:${target.branchName}` }
}

export async function gitPush(
  worktreePath: string,
  _publish = false,
  pushTarget?: GitPushTarget,
  options: { forceWithLease?: boolean } & GitRuntimeOptions = {}
): Promise<void> {
  try {
    if (pushTarget) {
      await validateGitPushTarget(worktreePath, pushTarget, options)
    }
    // Why: push to the branch's configured upstream when one exists. PR-created
    // worktrees can track a contributor fork remote; hardcoding origin here
    // would send review commits to the upstream repository instead.
    //
    // When no upstream exists, keep the existing first-publish behavior:
    // create/update origin/<current branch> and set it as upstream.
    //
    // Branch-vs-base reporting (the "Committed on Branch" section) is
    // unaffected because it uses branchCompare against an explicit baseRef
    // from worktree config, not the upstream relationship.
    const target = pushTarget
      ? explicitPushTarget(pushTarget)
      : await resolveConfiguredGitPushTarget((args) =>
          gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
        )
    const remoteName = target?.remote ?? 'origin'
    if (options.boundOperation && options.boundOperation.identity.remoteName !== remoteName) {
      throw new Error('Bound Git remote unavailable.')
    }
    const args = [
      'push',
      ...(options.forceWithLease ? ['--force-with-lease'] : []),
      '--set-upstream',
      ...(target ? [target.remote, target.refspec] : ['origin', 'HEAD'])
    ]
    await gitExecFileAsync(args, gitNetworkOptionsForWorktree(worktreePath, options))
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

async function gitPullWithArgs(
  worktreePath: string,
  pullArgs: string[],
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  const runPull = async (effectiveArgs: string[]): Promise<void> => {
    if (pushTarget) {
      const target = await validateGitPushTarget(worktreePath, pushTarget, options)
      await gitExecFileAsync(
        ['pull', ...effectiveArgs, target.remoteName, target.branchName],
        gitNetworkOptionsForWorktree(worktreePath, options)
      )
      return
    }
    const upstream = await resolveEffectiveGitUpstream((args) =>
      gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
    )
    if (
      upstream?.remoteName &&
      upstream.branchName &&
      (!upstream.isConfiguredUpstream || options.boundOperation)
    ) {
      if (
        options.boundOperation &&
        options.boundOperation.identity.remoteName !== upstream.remoteName
      ) {
        throw new Error('Bound Git remote unavailable.')
      }
      // Why: legacy Orca branches may still track origin/main while pushes
      // target origin/<branch>. Pull the same effective branch the UI reports.
      await gitExecFileAsync(
        ['pull', ...effectiveArgs, upstream.remoteName, upstream.branchName],
        gitNetworkOptionsForWorktree(worktreePath, options)
      )
      return
    }

    if (options.boundOperation) {
      throw new Error('Bound Git upstream unavailable.')
    }
    await gitExecFileAsync(['pull', ...effectiveArgs], gitOptionsForWorktree(worktreePath, options))
  }

  try {
    await runPullWithDivergenceFallback(pullArgs, runPull)
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitPull(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  // Why: plain `git pull` uses the user's configured pull strategy (merge by
  // default) so diverged branches reconcile instead of erroring out. Conflicts
  // surface through the existing conflict-resolution flow.
  postponeRepoRefMaintenance()
  await withRepoRefMaintenancePaused('git-pull', () => {
    const run = () =>
      runWithGitReadCacheInvalidation(() => gitPullWithArgs(worktreePath, [], pushTarget, options))
    return options.boundOperation
      ? run()
      : runWithGitWorktreeOperationLock(worktreePath, options.signal, run)
  })
}

export async function gitFastForward(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  postponeRepoRefMaintenance()
  await withRepoRefMaintenancePaused('git-fast-forward', () => {
    const run = () =>
      runWithGitReadCacheInvalidation(() =>
        gitPullWithArgs(worktreePath, ['--ff-only'], pushTarget, options)
      )
    return options.boundOperation
      ? run()
      : runWithGitWorktreeOperationLock(worktreePath, options.signal, run)
  })
}

export async function gitFetch(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  // `--prune` deletes remote-tracking refs, which needs the `packed-refs` lock a
  // running idle pack holds while it rewrites -- ~1.4s at most. This is the user
  // clicking Fetch, so wait that window out rather than letting it fail on the lock.
  postponeRepoRefMaintenance()
  try {
    await withRepoRefMaintenancePaused('git-fetch', async () => {
      if (options.boundOperation && pushTarget) {
        throw new Error('Bound Git fork fetch unavailable.')
      }
      if (pushTarget) {
        const target = await validateGitPushTarget(worktreePath, pushTarget, options)
        const runtimeOptions = gitOptionsForWorktree(worktreePath, options)
        await fetchForkRemoteWithStaleRefspecRepair(
          (args, cwd) => gitExecFileAsync(args, { ...runtimeOptions, cwd }),
          worktreePath,
          target.remoteName,
          () =>
            gitExecFileAsync(['fetch', '--prune', target.remoteName], runtimeOptions).then(
              () => undefined
            )
        )
        return
      }
      const remote = options.boundOperation?.identity.remoteName
      if (options.boundOperation && !remote) {
        throw new Error('Bound Git remote unavailable.')
      }
      await gitExecFileAsync(
        ['fetch', '--prune', ...(remote ? [remote] : [])],
        gitNetworkOptionsForWorktree(worktreePath, options)
      )
    })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'fetch'))
  }
}
