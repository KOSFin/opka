import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { getRepoName } from '../../git/repo'
import { resolveClonedFolderConversion } from '../../folder-repo-git-conversion'
import { findExtraFolderWorkspaceIds } from '../../folder-workspace-meta-presence'
import type { prepareBoundGitClone } from '../../git/command-runner/bound-git-clone'
import { ownsBoundGitCloneRepoRow } from '../../git/command-runner/bound-git-clone-owned-row'
import { emitRepoAdded } from './repo-added-telemetry'
import { notifyReposChanged } from './repos-changed-notification'

type BoundClone = Awaited<ReturnType<typeof prepareBoundGitClone>>

export async function registerLocalClonedRepo(
  mainWindow: BrowserWindow,
  store: Store,
  clonePath: string,
  findSaved: () => Repo | undefined,
  boundClone: BoundClone | null
): Promise<Repo> {
  const existing = findSaved()
  if (boundClone) {
    await boundClone.assertCurrent()
    if (existing) {
      throw new Error('A repository already owns this clone path.')
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
      getRepoExecutionHostId(current) === getRepoExecutionHostId(existing)
    ) {
      const updated = store.updateRepo(current, {
        kind: 'git',
        ...conversion,
        projectHostSetupMethod: 'cloned'
      })
      if (updated) {
        await prepareLocalWorktreeRootForRepo(store, updated)
        invalidateAuthorizedRootsCache()
        notifyReposChanged(mainWindow)
        emitRepoAdded('clone_url', false, true)
        return updated
      }
    }
    if (current) {
      await prepareLocalWorktreeRootForRepo(store, current)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('clone_url', true, true)
      return current
    }
  }

  const detected = await detectRepoIconAndUpstream({
    repoPath: clonePath,
    kind: 'git',
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  if (boundClone) {
    await boundClone.assertCurrent()
    if (findSaved()) {
      throw new Error('A repository already owns this clone path.')
    }
  }
  const repo: Repo = {
    id: randomUUID(),
    path: clonePath,
    displayName: getRepoName(clonePath),
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...detected,
    addedAt: Date.now(),
    kind: 'git',
    externalWorktreeVisibilityLegacy: false,
    projectHostSetupMethod: 'cloned'
  }
  store.addRepo(repo)
  try {
    const saved = boundClone
      ? store.setRepoGitNetworkBinding(repo, repo.path, repo.addedAt, null, boundClone.binding)
      : repo
    if (boundClone) {
      if (!ownsBoundGitCloneRepoRow(store, repo, boundClone.binding)) {
        throw new Error('Protected GitLab binding did not persist.')
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
    invalidateAuthorizedRootsCache()
    notifyReposChanged(mainWindow)
    emitRepoAdded('clone_url', false, true)
    return saved
  } catch (error) {
    if (boundClone && ownsBoundGitCloneRepoRow(store, repo, boundClone.binding, true)) {
      store.removeProjectForHost(repo)
    }
    throw error
  }
}
