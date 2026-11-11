import { isAbsolute } from 'node:path'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'

const PRIVATE_ENV_KEY =
  /^(?:GIT_|GITHUB_|GCM_|GH_|GLAB_|GITLAB_|CURL_|SSL_|ORCA_|ELECTRON_|LD_|DYLD_|SSH_ASKPASS$|NODE_OPTIONS$|NODE_PATH$|NODE_REPL_EXTERNAL_MODULE$|NETRC$|REQUESTS_CA_BUNDLE$|BASH_ENV$|ENV$|CDPATH$|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i

export function boundGitChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  endpoint: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env = boundGitPreflightEnvironment(inherited, platform)
  if (
    !endpoint.ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT ||
    !endpoint.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE
  ) {
    throw new Error('Bound Git credential endpoint unavailable.')
  }
  return {
    ...env,
    ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT: endpoint.ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT,
    ORCA_INTERNAL_GIT_CREDENTIAL_NONCE: endpoint.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE
  }
}

export function boundGitPreflightEnvironment(
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    throw new Error('Bound Git transport is unavailable on this host.')
  }
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (!PRIVATE_ENV_KEY.test(key)) {
      env[key] = value
    }
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: ''
  }
}

export function boundGitChildArgs(
  args: readonly string[],
  launcherPath: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32' || !isAbsolute(launcherPath) || /[\r\n\0]/.test(launcherPath)) {
    throw new Error('Bound Git helper unavailable.')
  }
  const helper = `!${quotePosixShell(launcherPath)} internal-git-credential`
  return [
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=${helper}`,
    '-c',
    'credential.useHttpPath=true',
    '-c',
    'http.followRedirects=false',
    '-c',
    'http.sslVerify=true',
    ...args
  ]
}
