import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readBoundGitEffectiveRemote } from './bound-git-effective-remote'

let root = ''
let repo = ''
let env: NodeJS.ProcessEnv = {}
const gitBinary = process.env.ORCA_GIT_COMPAT_BINARY ?? 'git'

async function git(args: readonly string[]): Promise<Buffer> {
  const result = await runProcess({
    program: gitBinary,
    args: [...args],
    cwd: repo,
    env,
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 3000
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Synthetic Git command unavailable.')
  }
  return Buffer.from(result.stdout)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bound-git-remote-'))
  repo = join(root, 'repo')
  env = {
    HOME: root,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  await mkdir(repo)
  await git(['init', '-q'])
  await git(['remote', 'add', 'origin', 'https://gitlab.com/team/a.git'])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')(
  'effective remote on the real selected Git binary',
  () => {
    it('reads exactly one HTTPS fetch and push destination without a network request', async () => {
      const fetch = await readBoundGitEffectiveRemote('fetch', 'origin', 'alice', git)
      const push = await readBoundGitEffectiveRemote('push', 'origin', 'alice', git)
      expect(fetch.remoteUrl).toBe('https://gitlab.com/team/a.git')
      expect(push.remoteUrl).toBe(fetch.remoteUrl)
      expect(push.configFingerprint).not.toBe(fetch.configFingerprint)
    })

    it('refuses two fetch destinations and a changed local configuration', async () => {
      await git(['remote', 'set-url', '--add', 'origin', 'https://gitlab.com/team/b.git'])
      await expect(readBoundGitEffectiveRemote('fetch', 'origin', 'alice', git)).rejects.toThrow(
        'Bound Git remote unavailable.'
      )
      await git(['remote', 'set-url', '--delete', 'origin', 'https://gitlab.com/team/b.git'])
      const before = await readBoundGitEffectiveRemote('fetch', 'origin', 'alice', git)
      await git(['config', '--local', 'core.autocrlf', 'false'])
      const after = await readBoundGitEffectiveRemote('fetch', 'origin', 'alice', git)
      expect(after.configFingerprint).not.toBe(before.configFingerprint)
    })

    it('refuses an included URL-matched header before releasing a credential', async () => {
      const include = join(root, 'synthetic-include.gitconfig')
      await writeFile(
        include,
        '[http "https://gitlab.com/"]\n\textraHeader = Authorization: synthetic-secret\n'
      )
      await git(['config', '--local', 'include.path', include])
      await expect(readBoundGitEffectiveRemote('push', 'origin', 'alice', git)).rejects.toThrow(
        'Bound Git configuration unavailable.'
      )
    })

    it('refuses worktree configuration that changes the actual Git HTTP request', async () => {
      await git(['config', '--local', 'extensions.worktreeConfig', 'true'])
      await git([
        'config',
        '--worktree',
        'http.https://gitlab.com/.extraheader',
        'Authorization: synthetic-worktree-secret'
      ])
      await expect(readBoundGitEffectiveRemote('fetch', 'origin', 'alice', git)).rejects.toThrow(
        'Bound Git configuration unavailable.'
      )
    })

    it('refuses a dotted remote name with its own proxy override', async () => {
      await git(['remote', 'add', 'team.origin', 'https://gitlab.com/team/b.git'])
      await git(['config', '--local', 'remote.team.origin.proxy', 'http://synthetic.invalid'])
      await expect(
        readBoundGitEffectiveRemote('push', 'team.origin', 'alice', git)
      ).rejects.toThrow('Bound Git configuration unavailable.')
    })
  }
)
