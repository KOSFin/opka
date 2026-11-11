import { describe, expect, it, vi } from 'vitest'
import { readBoundGitEffectiveRemote } from './bound-git-effective-remote'

function localRead(config: string, remote: string) {
  return vi.fn(async (args: readonly string[]) =>
    Buffer.from(args[0] === 'config' ? config : remote)
  )
}

describe('bound Git effective remote snapshot', () => {
  it('uses a single effective fetch URL and fingerprints effective config without exposing values', async () => {
    const read = localRead(
      'core.repositoryformatversion\n0\0remote.origin.url\nhttps://gitlab.com/team/a.git\0',
      'https://gitlab.com/team/a.git\n'
    )
    const snapshot = await readBoundGitEffectiveRemote('fetch', 'origin', 'alice', read)
    expect(snapshot.remoteUrl).toBe('https://gitlab.com/team/a.git')
    expect(snapshot.configFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(read).toHaveBeenNthCalledWith(1, ['config', '--includes', '--null', '--list'])
    expect(read).toHaveBeenNthCalledWith(2, ['remote', 'get-url', '--all', '--', 'origin'])
  })

  it('asks Git for the effective push destination and binds the operation in the fingerprint', async () => {
    const config = 'remote.origin.url\nhttps://gitlab.com/team/a.git\0'
    const read = localRead(config, 'https://gitlab.com/team/a.git\n')
    const fetch = await readBoundGitEffectiveRemote('fetch', 'origin', 'alice', read)
    const push = await readBoundGitEffectiveRemote('push', 'origin', 'alice', read)
    expect(push.configFingerprint).not.toBe(fetch.configFingerprint)
    expect(read).toHaveBeenLastCalledWith(['remote', 'get-url', '--all', '--push', '--', 'origin'])
  })

  it.each([
    'credential.helper\n!/synthetic/helper\0',
    'http.https://gitlab.com/.extraheader\nAuthorization: synthetic-secret\0',
    'http.followredirects\ntrue\0',
    'url.https://elsewhere.invalid/.insteadof\nhttps://gitlab.com/\0',
    'remote.origin.pushurl\nhttps://elsewhere.invalid/team/a.git\0',
    'remote.team.origin.proxy\nhttp://synthetic.invalid\0',
    'remote.team.origin.pushurl\nhttps://elsewhere.invalid/team/a.git\0',
    'protocol.ext.allow\nalways\0'
  ])('refuses unsafe local Git config before remote lookup', async (config) => {
    const read = localRead(config, 'https://gitlab.com/team/a.git\n')
    await expect(readBoundGitEffectiveRemote('fetch', 'origin', 'alice', read)).rejects.toThrow(
      'Bound Git configuration unavailable.'
    )
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://gitlab.com/team/a.git\nhttps://gitlab.com/team/b.git\n',
    'https://gitlab.com/team/a.git\nhttps://elsewhere.invalid/team/b.git\n',
    'https://alice:secret@gitlab.com/team/a.git\n',
    'http://gitlab.com/team/a.git\n'
  ])('refuses ambiguous or unsupported remote output', async (remote) => {
    const read = localRead('core.repositoryformatversion\n0\0', remote)
    await expect(readBoundGitEffectiveRemote('fetch', 'origin', 'alice', read)).rejects.toThrow()
  })

  it('refuses option-like remote names before executing Git', async () => {
    const read = localRead('core.repositoryformatversion\n0\0', '')
    await expect(
      readBoundGitEffectiveRemote('pull', '--upload-pack', 'alice', read)
    ).rejects.toThrow('Bound Git remote unavailable.')
    expect(read).not.toHaveBeenCalled()
  })
})
