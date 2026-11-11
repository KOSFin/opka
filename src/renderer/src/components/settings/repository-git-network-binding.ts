import type { Repo } from '../../../../shared/repo-types'
import type { BoundGitCloneChoice } from '../../../../shared/git-network-binding'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { callRuntimeRpc, getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'

export async function bindRepositoryGitNetworkAccount(
  repo: Repo,
  choice: BoundGitCloneChoice | null
): Promise<Repo> {
  const owner = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (owner?.kind === 'local') {
    if (
      choice?.provider === 'gitlab' ||
      (!choice && repo.gitNetworkBinding?.provider === 'gitlab')
    ) {
      return window.api.repos.bindGitLabNetworkProfile({
        repoId: repo.id,
        hostId: LOCAL_EXECUTION_HOST_ID,
        expectedPath: repo.path,
        profileId: choice?.provider === 'gitlab' ? choice.profileId : null
      })
    }
    return window.api.repos.bindGitHubNetworkAccount({
      repoId: repo.id,
      hostId: LOCAL_EXECUTION_HOST_ID,
      expectedPath: repo.path,
      account: choice?.provider === 'github' ? { host: choice.host, user: choice.user } : null
    })
  }
  if (owner?.kind !== 'runtime') {
    throw new Error('Git network account binding requires a connected execution host.')
  }
  const target = { kind: 'environment' as const, environmentId: owner.environmentId }
  const status = await getRuntimeEnvironmentStatus(owner.environmentId)
  const method =
    choice?.provider === 'gitlab' || (!choice && repo.gitNetworkBinding?.provider === 'gitlab')
      ? 'repo.gitLabProfile.bind'
      : 'repo.gitHubNetwork.bind'
  const params = {
    repo: repo.id,
    repoHostId: LOCAL_EXECUTION_HOST_ID,
    expectedPath: repo.path,
    ...(method === 'repo.gitLabProfile.bind'
      ? { profileId: choice?.provider === 'gitlab' ? choice.profileId : null }
      : {
          account: choice?.provider === 'github' ? { host: choice.host, user: choice.user } : null
        })
  }
  const result = await callRuntimeRpc<{ repo: Repo }>(target, method, params, {
    expectedEnvironmentRuntimeId: status.runtimeId
  })
  return result.repo
}

export function matchesRepositoryGitNetworkChoice(
  repo: Repo,
  choice: BoundGitCloneChoice | null
): boolean {
  const binding = repo.gitNetworkBinding
  if (!choice) {
    return !binding
  }
  return choice.provider === 'gitlab'
    ? binding?.provider === 'gitlab' && binding.id === choice.profileId
    : binding?.provider === 'github' && binding.host === choice.host && binding.user === choice.user
}
