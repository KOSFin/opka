import { defineMethod } from '../core'
import { RepoGitAuthorGet, RepoGitAuthorUpdate } from '../../../../shared/rpc-contract/repo-params'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { resolveGitRouteForHost } from '../../../providers/execution-host-provider-dispatch'
import { readRepoGitAuthor, updateRepoGitAuthor } from '../../../git/repo-git-author'
import { hostQualifiedRepoSelector } from '../../runtime-repo-selector'
import type { OrcaRuntimeService } from '../../orca-runtime'

async function authorRepoOnCurrentHost(
  runtime: OrcaRuntimeService,
  repoSelector: string,
  repoHostId: ExecutionHostId | undefined,
  expectedPath: string
) {
  const repo = await runtime.showRepo(hostQualifiedRepoSelector(repoSelector, repoHostId))
  if (
    repo.path !== expectedPath ||
    resolveGitRouteForHost(getRepoExecutionHostId(repo)).kind !== 'local'
  ) {
    throw new Error('Git author repository is unavailable on this execution host.')
  }
  return repo
}

export const REPO_GIT_AUTHOR_METHODS = [
  defineMethod({
    name: 'repo.gitAuthor.get',
    permission: 'workspace',
    params: RepoGitAuthorGet,
    handler: async (params, { runtime }) => ({
      author: await readRepoGitAuthor(
        await authorRepoOnCurrentHost(runtime, params.repo, params.repoHostId, params.expectedPath)
      )
    })
  }),
  defineMethod({
    name: 'repo.gitAuthor.update',
    permission: 'workspace',
    params: RepoGitAuthorUpdate,
    handler: async (params, { runtime }) => ({
      author: await updateRepoGitAuthor(
        await authorRepoOnCurrentHost(runtime, params.repo, params.repoHostId, params.expectedPath),
        {
          name: params.name,
          email: params.email,
          expectedLocalName: params.expectedLocalName,
          expectedLocalEmail: params.expectedLocalEmail
        }
      )
    })
  })
]
