import { homedir } from 'node:os'
import { isAbsolute, delimiter } from 'node:path'
import { glabExecFileAsync } from '../git/runner'
import { normalizeGitHttpsHost } from '../../shared/git-https-host'
import {
  normalizeGitLabNetworkUser,
  type GitLabNetworkProfile
} from '../../shared/gitlab-network-profile'
import { createGitLabNetworkProfileStore } from './gitlab-network-profile-store'

const STATUS_TIMEOUT_MS = 15_000
const IMPORT_ERROR =
  'This host could not import its saved glab login. Sign in to glab on this host and retry.'
type ProfileStore = Pick<
  ReturnType<typeof createGitLabNetworkProfileStore>,
  'list' | 'readToken' | 'provision'
>

export function parseNativeGlabProfileStatus(
  output: string,
  requestedHost: string
): { user: string; token: string } | null {
  const colorCode = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  const plain = output.replace(colorCode, '')
  const logins = [...plain.matchAll(/Logged in to (\S+) as (\S+) \([^)]+\)/g)]
  const tokens = [...plain.matchAll(/^\s*(?:[✓✔]\s*)?Token:\s*(\S+)\s*$/gm)]
  if (logins.length !== 1 || tokens.length !== 1) {
    return null
  }
  const host = normalizeGitHttpsHost(logins[0][1])
  const user = normalizeGitLabNetworkUser(logins[0][2])
  const token = tokens[0][1]
  if (
    host !== requestedHost ||
    !user ||
    !token ||
    token.length > 4096 ||
    /^\*+$/.test(token) ||
    [...token].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return null
  }
  return { user, token }
}

/** Reads a saved glab login and seals it on the same execution host; no credential crosses RPC. */
export async function importNativeGlabNetworkProfile(
  hostInput: string,
  options: {
    profiles?: ProfileStore
    readStatus?: (host: string) => Promise<string>
  } = {}
): Promise<GitLabNetworkProfile> {
  const host = normalizeGitHttpsHost(hostInput)
  if (!host || host !== hostInput) {
    throw new Error('Enter the GitLab HTTPS host for this repository.')
  }
  try {
    const profiles = options.profiles ?? createGitLabNetworkProfileStore()
    const readStatus =
      options.readStatus ??
      (async (selectedHost: string) => {
        const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', CLICOLOR: '0' }
        if (env.PATH) {
          env.PATH = env.PATH.split(delimiter).filter(isAbsolute).join(delimiter)
        }
        for (const key of ['GITLAB_TOKEN', 'GLAB_TOKEN', 'GITLAB_HOST', 'GLAB_HOST']) {
          delete env[key]
        }
        // glab refuses --hostname unless it is in this host's configured login inventory.
        const { stdout, stderr } = await glabExecFileAsync(
          ['auth', 'status', '--hostname', selectedHost, '--show-token'],
          {
            cwd: homedir(),
            timeout: STATUS_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
            env,
            allowDefaultWslFallback: false
          }
        )
        return `${stdout}\n${stderr}`
      })
    const login = parseNativeGlabProfileStatus(await readStatus(host), host)
    if (!login) {
      throw new Error(IMPORT_ERROR)
    }
    const existing = profiles
      .list()
      .find((profile) => profile.host === host && profile.user === login.user)
    if (existing) {
      try {
        if (profiles.readToken(existing) === login.token) {
          return existing
        }
      } catch {
        // A damaged saved profile is replaced only after the native login verifies again.
      }
    }
    return await profiles.provision({ host, user: login.user, token: login.token })
  } catch {
    throw new Error(IMPORT_ERROR)
  }
}
