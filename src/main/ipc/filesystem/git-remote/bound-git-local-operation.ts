import { getAppEnvironment } from '../../../../shared/app-environment'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeStore } from '../../../runtime/runtime-store-contract'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  worktreeIdsEqual,
  composeWorktreeId,
  splitWorktreeId
} from '../../../../shared/worktree/id'
import { resolveGitCommonDirectory } from '../../../../shared/git-common-directory'
import { resolveEffectiveGitUpstream } from '../../../../shared/git-effective-upstream'
import { resolveConfiguredGitPushTarget } from '../../../../shared/git-push-target-resolution'
import { createGitLabNetworkProfileStore } from '../../../gitlab/gitlab-network-profile-store'
import {
  invalidateGhAccountTokenCache,
  resolveGhAccountToken
} from '../../../github/gh-account-token'
import { validateGhAccountBinding } from '../../../github/gh-account-binding-inventory'
import type { GhAccountBinding } from '../../../../shared/github/account-binding'
import { gitExecFileAsync } from '../../../git/runner'
import { boundGitPreflightEnvironment } from '../../../git/command-runner/bound-git-child-command'
import { getLocalBoundReposForRegisteredWorktree } from '../../local-worktree-runtime-options'
import type { BoundGitExecution } from '../../../git/command-runner/bound-git-network-executor'
import type { BoundGitOwnerIdentity } from '../../../git/command-runner/bound-git-operation-credential'

type BoundLocalOperation = {
  operation: 'fetch' | 'pull' | 'push'
  requestedPath: string
  resolvedPath: string
  worktreeId?: string
  remoteName: string
  pushTarget?: GitPushTarget
}

type BoundLocalOperationDependencies = {
  profileStore?: Pick<ReturnType<typeof createGitLabNetworkProfileStore>, 'list' | 'readToken'>
  launcherPath?: string | null
  readGitHubToken?: (account: GhAccountBinding) => Promise<string>
  validateGitHubAccount?: (account: GhAccountBinding) => Promise<boolean>
}

type BoundGitRepoStore = Pick<RuntimeStore, 'getRepos' | 'getAllWorktreeMeta'>

function boundUnavailable(): Error {
  return new Error('Selected Git network profile is unavailable on this host or client.')
}

async function isAliasOfBoundRepository(store: BoundGitRepoStore, path: string): Promise<boolean> {
  const boundRepos = store
    .getRepos()
    .filter(
      (entry) => getRepoExecutionHostId(entry) === 'local' && Boolean(entry.gitNetworkBinding)
    )
  if (boundRepos.length === 0) {
    return false
  }
  const realPath = await realpath(path).catch(() => null)
  const commonDir = await resolveGitCommonDirectory(path).catch(() => null)
  const realCommonDir = commonDir ? await realpath(commonDir).catch(() => null) : null
  for (const repo of boundRepos) {
    if (realPath && (await realpath(repo.path).catch(() => null)) === realPath) {
      return true
    }
    if (!realCommonDir) {
      continue
    }
    const repoCommonDir = await resolveGitCommonDirectory(repo.path).catch(() => null)
    if (repoCommonDir && (await realpath(repoCommonDir).catch(() => null)) === realCommonDir) {
      return true
    }
  }
  return false
}

async function selectedRemoteName(args: BoundLocalOperation): Promise<string> {
  if (args.pushTarget) {
    return args.pushTarget.remoteName
  }
  if (args.operation === 'fetch') {
    return args.remoteName
  }
  const isolatedHome = await mkdtemp(join(tmpdir(), 'orca-bound-git-remote-'))
  try {
    const env = boundGitPreflightEnvironment({
      ...process.env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome
    })
    const readGit = (argv: string[]): Promise<{ stdout: string; stderr: string }> =>
      gitExecFileAsync(argv, { cwd: args.resolvedPath, env })
    if (args.operation === 'push') {
      return (await resolveConfiguredGitPushTarget(readGit))?.remote ?? 'origin'
    }
    const upstream = await resolveEffectiveGitUpstream(readGit)
    if (!upstream?.remoteName) {
      throw boundUnavailable()
    }
    return upstream.remoteName
  } finally {
    await rm(isolatedHome, { recursive: true, force: true })
  }
}

export async function assertNoBoundGitProfileForUnsupportedOperation(
  store: BoundGitRepoStore,
  requestedPath: string,
  resolvedPath: string
): Promise<void> {
  if (
    getLocalBoundReposForRegisteredWorktree(store, requestedPath, resolvedPath).length > 0 ||
    (await isAliasOfBoundRepository(store, resolvedPath))
  ) {
    throw boundUnavailable()
  }
}

export async function boundGitLocalOperationForWorktree(
  store: BoundGitRepoStore,
  args: BoundLocalOperation,
  dependencies: BoundLocalOperationDependencies = {}
): Promise<BoundGitExecution | null> {
  const boundRepos = getLocalBoundReposForRegisteredWorktree(
    store,
    args.requestedPath,
    args.resolvedPath
  )
  const repo = boundRepos[0]
  const worktreeRepoId = splitWorktreeId(args.worktreeId ?? '')?.repoId
  if (!repo) {
    if (
      store
        .getRepos()
        .some(
          (entry) =>
            entry.id === worktreeRepoId &&
            getRepoExecutionHostId(entry) === 'local' &&
            entry.gitNetworkBinding
        )
    ) {
      throw boundUnavailable()
    }
    if (await isAliasOfBoundRepository(store, args.resolvedPath)) {
      throw boundUnavailable()
    }
    return null
  }
  if (boundRepos.length !== 1 || worktreeRepoId !== repo.id) {
    throw boundUnavailable()
  }
  if (!repo.gitNetworkBinding) {
    throw boundUnavailable()
  }
  const binding = repo.gitNetworkBinding
  if (
    process.platform === 'win32' ||
    getRepoExecutionHostId(repo) !== 'local' ||
    isFolderRepo(repo) ||
    !args.worktreeId ||
    !worktreeIdsEqual(args.worktreeId, composeWorktreeId(repo.id, args.resolvedPath)) ||
    (args.operation === 'fetch' && args.pushTarget) ||
    (args.pushTarget?.remoteUrl && !args.pushTarget.remoteCreated)
  ) {
    throw boundUnavailable()
  }
  const profileStore =
    binding.provider === 'gitlab'
      ? (dependencies.profileStore ?? createGitLabNetworkProfileStore())
      : null
  if (binding.provider === 'gitlab') {
    const currentProfile = profileStore?.list().find((profile) => profile.id === binding.id)
    if (
      !currentProfile ||
      currentProfile.host !== binding.host ||
      currentProfile.user !== binding.user ||
      currentProfile.generation !== binding.generation
    ) {
      throw boundUnavailable()
    }
  }
  const launcherPath =
    dependencies.launcherPath === undefined
      ? (getAppEnvironment().getCliLauncherPath?.() ?? null)
      : dependencies.launcherPath
  const commonDirPath = await resolveGitCommonDirectory(args.resolvedPath)
  const commonGitDir = commonDirPath ? await realpath(commonDirPath).catch(() => null) : null
  if (!launcherPath || !commonGitDir) {
    throw boundUnavailable()
  }
  const remoteName = await selectedRemoteName(args)
  const validateGitHubAccount =
    dependencies.validateGitHubAccount ??
    (async (account: GhAccountBinding) =>
      (await validateGhAccountBinding(account, {}, { requiredHost: account.host })).ok)
  const expected: BoundGitOwnerIdentity = {
    operation: args.operation,
    repoId: repo.id,
    worktreeId: args.worktreeId,
    worktreePath: args.resolvedPath,
    commonGitDir,
    remoteName,
    executionHostId: 'local',
    connectionGeneration: String(repo.addedAt),
    profileId:
      binding.provider === 'gitlab' ? binding.id : `github\0${binding.host}\0${binding.user}`,
    profileGeneration: binding.generation,
    profileHost: binding.host,
    username: binding.user
  }
  const readCurrentIdentity = async (): Promise<BoundGitOwnerIdentity | null> => {
    try {
      const currentRepos = getLocalBoundReposForRegisteredWorktree(
        store,
        args.requestedPath,
        args.resolvedPath
      )
      const currentRepo = currentRepos.length === 1 ? currentRepos[0] : undefined
      const currentBinding = currentRepo?.gitNetworkBinding
      if (
        !currentRepo ||
        currentRepo.id !== repo.id ||
        currentRepo.path !== repo.path ||
        currentRepo.addedAt !== repo.addedAt ||
        getRepoExecutionHostId(currentRepo) !== 'local' ||
        !currentBinding ||
        currentBinding.provider !== binding.provider ||
        currentBinding.generation !== binding.generation ||
        currentBinding.host !== binding.host ||
        currentBinding.user !== binding.user ||
        (binding.provider === 'gitlab' &&
          (currentBinding.provider !== 'gitlab' ||
            currentBinding.id !== binding.id ||
            !profileStore
              ?.list()
              .some(
                (entry) =>
                  entry.id === binding.id &&
                  entry.generation === binding.generation &&
                  entry.host === binding.host &&
                  entry.user === binding.user
              )))
      ) {
        return null
      }
      if (binding.provider === 'github' && !(await validateGitHubAccount(binding))) {
        return null
      }
      const currentCommonPath = await resolveGitCommonDirectory(args.resolvedPath)
      const currentCommonDir = currentCommonPath
        ? await realpath(currentCommonPath).catch(() => null)
        : null
      return { ...expected, commonGitDir: currentCommonDir }
    } catch {
      return null
    }
  }
  if ((await readCurrentIdentity()) === null) {
    throw boundUnavailable()
  }
  return {
    identity: expected,
    launcherPath,
    readCurrentIdentity,
    readPassword: async () => {
      if (binding.provider === 'gitlab') {
        if (!profileStore) {
          throw boundUnavailable()
        }
        return profileStore.readToken(binding)
      }
      if (dependencies.readGitHubToken) {
        return dependencies.readGitHubToken(binding)
      }
      invalidateGhAccountTokenCache(binding)
      if (!(await validateGitHubAccount(binding))) {
        throw boundUnavailable()
      }
      return resolveGhAccountToken(binding)
    }
  }
}
