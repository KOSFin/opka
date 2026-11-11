import type { GitCredentialRequest } from '../../../shared/git-credential-protocol'
import { normalizeGitHttpsHost } from '../../../shared/git-https-host'

export type BoundGitCredentialTarget = {
  url: string
  host: string
  port: string
  path: string
  username: string
}

export function parseBoundGitCredentialTarget(
  rawUrl: string,
  username: string
): BoundGitCredentialTarget {
  if (
    !username ||
    /[\r\n\0]/.test(username) ||
    rawUrl.trim() !== rawUrl ||
    /[%\\?#\s]|\/(?:\.|\.\.)(?:\/|$)/.test(rawUrl)
  ) {
    throw new Error('Bound Git target unavailable.')
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Bound Git target unavailable.')
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    normalizeGitHttpsHost(parsed.host) !== parsed.host ||
    !parsed.pathname ||
    parsed.pathname === '/'
  ) {
    throw new Error('Bound Git target unavailable.')
  }
  return {
    url: parsed.href,
    host: parsed.hostname,
    port: parsed.port || '443',
    path: parsed.pathname.slice(1),
    username
  }
}

export function matchesBoundGitCredentialTarget(
  target: BoundGitCredentialTarget,
  request: GitCredentialRequest
): boolean {
  if (request.protocol !== 'https' || request.path !== target.path) {
    return false
  }
  if (request.username !== undefined && request.username !== target.username) {
    return false
  }
  let requestedHost: URL
  try {
    requestedHost = new URL(`https://${request.host}/`)
  } catch {
    return false
  }
  return (
    requestedHost.hostname === target.host &&
    (requestedHost.port || '443') === target.port &&
    requestedHost.username === '' &&
    requestedHost.password === '' &&
    requestedHost.pathname === '/' &&
    requestedHost.search === '' &&
    requestedHost.hash === ''
  )
}
