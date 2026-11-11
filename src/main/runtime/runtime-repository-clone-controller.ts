import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { getGitCloneFailureMessage } from '../../shared/git-clone-failure-message'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey
} from '../git/repo-clone-path'
import { gitSpawnAfterWindowsEnvironmentReady, promptGuardGitEnv } from '../git/runner'
import { reuseSavedCloneTarget } from '../git/saved-clone-target'
import { runWithGitReadCacheInvalidation } from '../git/status'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { getRepoName } from '../git/repo'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimeRepoIsRegistrationCandidate } from './runtime-worktree-selection'
import { resolveClonedFolderConversion } from '../folder-repo-git-conversion'
import { findExtraFolderWorkspaceIds } from '../folder-workspace-meta-presence'
import { prepareBoundGitClone } from '../git/command-runner/bound-git-clone'
import { ownsBoundGitCloneRepoRow } from '../git/command-runner/bound-git-clone-owned-row'
import { validateBoundGitCloneSelection } from '../git/command-runner/bound-git-clone-selection'
import type { BoundGitCloneChoice } from '../../shared/git-network-binding'

type RuntimeRepositoryCloneDependencies = {
  getStore: () => RuntimeStore | null
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyReposChanged: () => void
}

export class RuntimeRepositoryCloneController {
  private readonly inFlightByPath = new Map<string, Promise<void>>()

  constructor(private readonly deps: RuntimeRepositoryCloneDependencies) {}

  async clone(
    url: string,
    destination: string,
    executionHostId?: ExecutionHostId | null,
    gitNetworkChoice?: BoundGitCloneChoice
  ): Promise<Repo> {
    if (!this.deps.getStore()) {
      throw new Error('runtime_unavailable')
    }
    const trimmedUrl = url.trim()
    const trimmedDestination = destination.trim()
    if (!trimmedDestination) {
      throw new Error('Clone destination is required')
    }
    const clonePath = deriveValidatedClonePath({ url: trimmedUrl, destination: trimmedDestination })
    const clonePathKey = getClonePathComparisonKey(clonePath)
    const previous = this.inFlightByPath.get(clonePathKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current
    )
    this.inFlightByPath.set(clonePathKey, tail)
    try {
      await previous
      return await runWithGitReadCacheInvalidation(() =>
        this.cloneAfterPathLock(
          trimmedUrl,
          trimmedDestination,
          clonePath,
          clonePathKey,
          executionHostId,
          gitNetworkChoice
        )
      )
    } finally {
      release()
      if (this.inFlightByPath.get(clonePathKey) === tail) {
        this.inFlightByPath.delete(clonePathKey)
      }
    }
  }

  private async cloneAfterPathLock(
    trimmedUrl: string,
    trimmedDestination: string,
    clonePath: string,
    clonePathKey: string,
    executionHostId?: ExecutionHostId | null,
    gitNetworkChoice?: BoundGitCloneChoice
  ): Promise<Repo> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    // Why: git runs in this process, so an SSH project at the same path string is another machine's.
    const findSaved = (): Repo | undefined =>
      store.getRepos().find((repo) => {
        return (
          getClonePathComparisonKey(repo.path) === clonePathKey &&
          runtimeRepoIsRegistrationCandidate(repo, executionHostId)
        )
      })
    const reused = await reuseSavedCloneTarget(findSaved, trimmedUrl, LOCAL_EXECUTION_HOST_ID)
    if (reused) {
      if (gitNetworkChoice) {
        throw new Error('Select the Git network account in the existing repository settings.')
      }
      return reused
    }
    if (
      gitNetworkChoice &&
      (findSaved() ||
        (executionHostId != null && executionHostId !== LOCAL_EXECUTION_HOST_ID) ||
        !store.setRepoGitNetworkBinding ||
        !store.removeProjectForHost ||
        !store.flushPendingOrThrowAsync)
    ) {
      throw new Error('Selected Git network profile is unavailable on this host or client.')
    }
    const selection = gitNetworkChoice
      ? await validateBoundGitCloneSelection(trimmedUrl, gitNetworkChoice)
      : null

    await mkdir(trimmedDestination, { recursive: true })
    const claimedTarget = await claimCloneTarget(clonePath)
    let boundClone: Awaited<ReturnType<typeof prepareBoundGitClone>> | null = null
    let proc: Awaited<ReturnType<typeof gitSpawnAfterWindowsEnvironmentReady>>
    try {
      if (selection) {
        boundClone = await prepareBoundGitClone({
          url: trimmedUrl,
          destination: trimmedDestination,
          clonePath,
          claimedTarget,
          selection
        })
      }
      proc = await gitSpawnAfterWindowsEnvironmentReady(
        boundClone?.args ?? ['clone', '--progress', '--', trimmedUrl, clonePath],
        {
          cwd: trimmedDestination,
          admissionTier: 'interactive',
          env: boundClone?.env ?? promptGuardGitEnv(),
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )
    } catch (error) {
      await boundClone?.close()
      await cleanupClaimedCloneTarget(clonePath, claimedTarget)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Clone failed: ${message}`)
    }
    await new Promise<void>((resolve, reject) => {
      let stderrTail = ''
      let settled = false
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096)
      })
      const finish = async (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        if (error || code !== 0 || signal) {
          await cleanupClaimedCloneTarget(clonePath, claimedTarget)
        }
        if (error) {
          reject(new Error(`Clone failed: ${error.message}`))
        } else if (signal === 'SIGTERM') {
          reject(new Error('Clone aborted'))
        } else if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Clone failed: ${getGitCloneFailureMessage(stderrTail, { clonePath })}`))
        }
      }
      proc.on('error', (error) => void finish(null, null, error))
      proc.on('close', (code, signal) => void finish(code, signal))
    }).finally(async () => {
      await boundClone?.close()
    })

    const existing = findSaved()
    if (boundClone) {
      try {
        await boundClone.assertCurrent()
        if (existing) {
          throw new Error('A repository already owns this clone path.')
        }
      } catch (error) {
        await cleanupClaimedCloneTarget(clonePath, claimedTarget)
        throw error
      }
    }
    if (existing) {
      const conversion = await resolveClonedFolderConversion(store, existing)
      const current = findSaved()
      if (
        current &&
        conversion &&
        findExtraFolderWorkspaceIds(current, store.getAllWorktreeMeta()).length === 0 &&
        current.path === existing.path &&
        isFolderRepo(current) &&
        runtimeRepoIsRegistrationCandidate(current, executionHostId)
      ) {
        const updated = store.updateRepo(current, { kind: 'git', ...conversion })
        if (updated) {
          await prepareLocalWorktreeRootForRepo(store, updated)
          invalidateAuthorizedRootsCache()
          this.invalidate(updated.id)
          return updated
        }
      }
      // Why: git re-created this project's folder, so its worktree root is gone with it and the
      // authorized-roots cache still holds the answers from before the folder came back.
      if (current) {
        await prepareLocalWorktreeRootForRepo(store, current)
        invalidateAuthorizedRootsCache()
        this.invalidate(current.id)
        return current
      }
    }
    // `cloneRepo` ran `git clone` in this process (see `assertCloneHostIsSupported`), so the
    // checkout is here regardless of the host id stamped on the row.
    const detected = await detectRepoIconAndUpstream({
      repoPath: clonePath,
      kind: 'git',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    if (boundClone) {
      try {
        await boundClone.assertCurrent()
        if (findSaved()) {
          throw new Error('A repository already owns this clone path.')
        }
      } catch (error) {
        if (!findSaved()) {
          await cleanupClaimedCloneTarget(clonePath, claimedTarget)
        }
        throw error
      }
    }
    const repo: Repo = {
      id: randomUUID(),
      path: clonePath,
      displayName: getRepoName(clonePath),
      badgeColor: DEFAULT_REPO_BADGE_COLOR,
      ...(executionHostId != null ? { executionHostId } : {}),
      ...detected,
      addedAt: Date.now(),
      kind: 'git',
      externalWorktreeVisibilityLegacy: false
    }
    store.addRepo(repo)
    let saved = repo
    try {
      if (boundClone) {
        if (!store.setRepoGitNetworkBinding) {
          throw new Error('Protected Git binding unavailable.')
        }
        saved = store.setRepoGitNetworkBinding(
          repo,
          repo.path,
          repo.addedAt,
          null,
          boundClone.binding
        )
        if (!ownsBoundGitCloneRepoRow(store, repo, boundClone.binding)) {
          throw new Error('Protected GitLab binding did not persist.')
        }
        if (!store.flushPendingOrThrowAsync) {
          throw new Error('Protected GitLab save unavailable.')
        }
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        await boundClone.assertCurrent()
        if (!ownsBoundGitCloneRepoRow(store, repo, boundClone.binding)) {
          throw new Error('Protected GitLab binding changed during save.')
        }
      }
      await prepareLocalWorktreeRootForRepo(store, saved)
      if (boundClone) {
        await boundClone.assertCurrent()
        if (!ownsBoundGitCloneRepoRow(store, repo, boundClone.binding)) {
          throw new Error('Selected Git network binding changed before clone completion.')
        }
      }
    } catch (error) {
      if (boundClone) {
        if (ownsBoundGitCloneRepoRow(store, repo, boundClone.binding, true)) {
          store.removeProjectForHost?.(repo)
        }
        if (!findSaved()) {
          await cleanupClaimedCloneTarget(clonePath, claimedTarget)
        }
      }
      throw error
    }
    invalidateAuthorizedRootsCache()
    this.invalidate(repo.id)
    return store.getRepo(repo.id) ?? saved
  }

  private invalidate(repoId: string): void {
    this.deps.invalidateResolvedWorktrees()
    this.deps.invalidateWorktreeScan(repoId)
    this.deps.notifyReposChanged()
  }
}
