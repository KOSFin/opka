import type { PreloadApi } from '../../../../preload/api-types'
import { legacyBaseRefSearchResult } from '../../../../shared/base-ref-search-result'
import type { Repo } from '../../../../shared/repo-types'
import type { RepoGitAuthor } from '../../../../shared/repo-git-author'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getDefaultCreateProjectParent } from '@/components/sidebar/create-project-defaults'
import {
  callRuntimeResult,
  callRuntimeResultWithOwner,
  withRuntimeRepoMutationOwner,
  withRuntimeRepoOwner
} from './web-runtime-calls'
import { invalidateRuntimeWorktreeCaches } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'

export function createReposApi(): NonNullable<Partial<PreloadApi>['repos']> {
  return {
    list: async () => {
      const owned = await callRuntimeResultWithOwner<{ repos: Repo[] }>('repo.list')
      return owned.result.repos.map((repo) => withRuntimeRepoOwner(repo, owned.hostId))
    },
    add: async ({ path, kind, displayName }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo } | { error: string }>(
        'repo.add',
        { path, kind, displayName }
      )
      return withRuntimeRepoMutationOwner(owned.result, owned.hostId)
    },
    // Why: host-scoped forget targets a desktop-owned SSH host; a paired web client has one runtime and no ghost-host state.
    removeForHost: () => {
      throw new Error('Forgetting a host is unavailable in paired web clients.')
    },
    reorder: async ({ orderedIds }) => callRuntimeResult('repo.reorder', { orderedIds }),
    // Why: this persists desktop-owned local/SSH rows; paired web clients own one runtime and use repo.reorder directly.
    reorderForHost: async () => {
      throw new Error('Host-scoped project reordering is unavailable in paired web clients.')
    },
    update: async ({ repoId, updates }) => {
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>('repo.update', {
        repo: repoId,
        updates
      })
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    pickFolder: () => Promise.resolve(null),
    pickFolders: () => Promise.resolve([]),
    pickDirectory: () => Promise.resolve(null),
    clone: async ({ url, destination, gitNetworkChoice }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>(
        gitNetworkChoice?.provider === 'gitlab'
          ? 'repo.cloneBoundGitLab'
          : gitNetworkChoice?.provider === 'github'
            ? 'repo.cloneBoundGitHub'
            : 'repo.clone',
        {
          url,
          destination,
          ...(gitNetworkChoice?.provider === 'gitlab'
            ? { profileId: gitNetworkChoice.profileId }
            : gitNetworkChoice?.provider === 'github'
              ? { account: { host: gitNetworkChoice.host, user: gitNetworkChoice.user } }
              : {})
        },
        10 * 60_000
      )
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    cloneAbort: () => Promise.resolve(),
    bindGitLabNetworkProfile: async ({ repoId, expectedPath, profileId, remoteName }) => {
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>('repo.gitLabProfile.bind', {
        repo: repoId,
        repoHostId: LOCAL_EXECUTION_HOST_ID,
        expectedPath,
        profileId,
        remoteName
      })
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    bindGitHubNetworkAccount: async ({ repoId, expectedPath, account, remoteName }) => {
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>('repo.gitHubNetwork.bind', {
        repo: repoId,
        repoHostId: LOCAL_EXECUTION_HOST_ID,
        expectedPath,
        account,
        remoteName
      })
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    create: async ({ parentPath, name, kind }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo } | { error: string }>(
        'repo.create',
        { parentPath, name, kind }
      )
      return withRuntimeRepoMutationOwner(owned.result, owned.hostId)
    },
    isGitAvailable: async () =>
      (await callRuntimeResult<{ available: boolean }>('repo.gitAvailable')).available,
    getDefaultCreateProjectParent: async () => {
      const result = await callRuntimeResult<{ resolvedPath: string }>('files.browseServerDir', {
        path: '~'
      })
      return getDefaultCreateProjectParent(result.resolvedPath)
    },
    onCloneProgress: () => noopUnsubscribe,
    getGitUsername: () => Promise.resolve(''),
    getGitAuthor: async ({ repoId, expectedPath }) =>
      (
        await callRuntimeResult<{ author: RepoGitAuthor }>('repo.gitAuthor.get', {
          repo: repoId,
          repoHostId: LOCAL_EXECUTION_HOST_ID,
          expectedPath
        })
      ).author,
    updateGitAuthor: async ({ repoId, expectedPath, ...update }) =>
      (
        await callRuntimeResult<{ author: RepoGitAuthor }>('repo.gitAuthor.update', {
          repo: repoId,
          repoHostId: LOCAL_EXECUTION_HOST_ID,
          expectedPath,
          ...update
        })
      ).author,
    getBaseRefDefault: async ({ repoId }) =>
      callRuntimeResult('repo.baseRefDefault', { repo: repoId }),
    searchBaseRefs: async ({ repoId, query, limit }) =>
      (
        await callRuntimeResult<{ refs: string[] }>('repo.searchRefs', {
          repo: repoId,
          query,
          limit
        })
      ).refs,
    searchBaseRefDetails: async ({ repoId, query, limit }) => {
      const result = await callRuntimeResult<{
        refs: string[]
        refDetails?: { refName: string; localBranchName: string }[]
      }>('repo.searchRefs', {
        repo: repoId,
        query,
        limit
      })
      return result.refDetails ?? result.refs.map(legacyBaseRefSearchResult)
    },
    onChanged: () => noopUnsubscribe
  }
}
