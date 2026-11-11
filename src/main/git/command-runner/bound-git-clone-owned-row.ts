import type { Repo } from '../../../shared/repo-types'
import type { GitNetworkBinding } from '../../../shared/git-network-binding'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export function ownsBoundGitCloneRepoRow(
  store: { getRepos(): Repo[] },
  repo: Repo,
  binding: GitNetworkBinding,
  allowUnbound = false
): boolean {
  return store
    .getRepos()
    .some(
      (current) =>
        current.id === repo.id &&
        current.path === repo.path &&
        current.addedAt === repo.addedAt &&
        getRepoExecutionHostId(current) === LOCAL_EXECUTION_HOST_ID &&
        ((current.gitNetworkBinding?.provider === binding.provider &&
          current.gitNetworkBinding?.generation === binding.generation) ||
          (allowUnbound && current.gitNetworkBinding === undefined))
    )
}
