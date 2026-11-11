import { isGitLabNetworkProfile, type GitLabNetworkProfile } from './gitlab-network-profile'
import { isGitHubNetworkBinding, type GitHubNetworkBinding } from './github/account-binding'

export type GitNetworkBinding =
  | ({ provider: 'gitlab' } & GitLabNetworkProfile)
  | ({ provider: 'github' } & GitHubNetworkBinding)

export type BoundGitCloneChoice =
  | { provider: 'gitlab'; profileId: string }
  | { provider: 'github'; host: string; user: string }

export function isGitNetworkBinding(value: unknown): value is GitNetworkBinding {
  if (!value || typeof value !== 'object' || !('provider' in value)) {
    return false
  }
  return value.provider === 'gitlab'
    ? isGitLabNetworkProfile(value)
    : value.provider === 'github' && isGitHubNetworkBinding(value)
}
