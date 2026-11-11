import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundGitPreflightEnvironment } from '../git/command-runner/bound-git-child-command'
import { readBoundGitEffectiveRemote } from '../git/command-runner/bound-git-effective-remote'
import { gitExecFileAsyncBuffer } from '../git/runner'

/** Read both effective URLs under the same isolated Git configuration as the bound child. */
export async function readGitNetworkRemoteHost(
  repoPath: string,
  remoteName: string,
  user: string
): Promise<string> {
  const isolatedHome = await mkdtemp(join(tmpdir(), 'orca-git-network-bind-'))
  try {
    const env = boundGitPreflightEnvironment({
      ...process.env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome
    })
    const readGit = async (args: readonly string[]): Promise<Buffer> => {
      const output = await gitExecFileAsyncBuffer([...args], {
        cwd: repoPath,
        env,
        maxBuffer: 1024 * 1024,
        timeout: 2000
      })
      return output.stdout
    }
    const fetch = await readBoundGitEffectiveRemote('fetch', remoteName, user, readGit)
    const push = await readBoundGitEffectiveRemote('push', remoteName, user, readGit)
    const fetchHost = new URL(fetch.remoteUrl).host
    return fetchHost === new URL(push.remoteUrl).host ? fetchHost : ''
  } finally {
    await rm(isolatedHome, { recursive: true, force: true })
  }
}
