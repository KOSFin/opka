import { normalizeGitHttpsHost } from './git-https-host'

export type GitLabNetworkProfile = {
  id: string
  host: string
  user: string
  generation: string
}

export function normalizeGitLabNetworkUser(value: string): string | null {
  const user = value.trim().toLowerCase()
  return /^[a-z0-9_.-]{1,255}$/.test(user) ? user : null
}

export function isGitLabNetworkProfile(value: unknown): value is GitLabNetworkProfile {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (!('id' in value) || !('host' in value) || !('user' in value) || !('generation' in value)) {
    return false
  }
  return (
    typeof value.id === 'string' &&
    /^[a-f0-9]{64}$/.test(value.id) &&
    typeof value.host === 'string' &&
    normalizeGitHttpsHost(value.host) === value.host &&
    typeof value.user === 'string' &&
    normalizeGitLabNetworkUser(value.user) === value.user &&
    typeof value.generation === 'string' &&
    /^[a-f0-9-]{36}$/.test(value.generation)
  )
}
