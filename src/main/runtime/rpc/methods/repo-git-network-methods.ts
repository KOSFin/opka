import { defineMethod } from '../core'
import { projectRepoVisibilityForClient } from '../repo-visibility-projection'
import { hostQualifiedRepoSelector } from '../../runtime-repo-selector'
import {
  RepoCloneBoundGitLab,
  RepoCloneBoundGitHub,
  RepoGitLabProfileBind,
  RepoGitHubNetworkBind
} from '../../../../shared/rpc-contract/repo-params'

export const REPO_GIT_NETWORK_METHODS = [
  defineMethod({
    name: 'repo.cloneBoundGitLab',
    permission: 'workspace',
    params: RepoCloneBoundGitLab,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.cloneRepo(params.url, params.destination, undefined, {
          provider: 'gitlab',
          profileId: params.profileId
        }),
        context
      )
    })
  }),
  defineMethod({
    name: 'repo.cloneBoundGitHub',
    permission: 'workspace',
    params: RepoCloneBoundGitHub,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.cloneRepo(params.url, params.destination, undefined, {
          provider: 'github',
          ...params.account
        }),
        context
      )
    })
  }),
  defineMethod({
    name: 'repo.gitLabProfile.bind',
    permission: 'workspace',
    params: RepoGitLabProfileBind,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.bindGitLabNetworkProfile(
          hostQualifiedRepoSelector(params.repo, params.repoHostId),
          params.profileId,
          params.remoteName,
          params.expectedPath
        ),
        context
      )
    })
  }),
  defineMethod({
    name: 'repo.gitHubNetwork.bind',
    permission: 'workspace',
    params: RepoGitHubNetworkBind,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.bindGitHubNetworkAccount(
          hostQualifiedRepoSelector(params.repo, params.repoHostId),
          params.account,
          params.remoteName,
          params.expectedPath
        ),
        context
      )
    })
  })
]
