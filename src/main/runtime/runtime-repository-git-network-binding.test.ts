import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'
import { RuntimeRepositorySettingsController } from './runtime-repository-settings-controller'

const gitlab = {
  id: 'a'.repeat(64),
  host: 'gitlab.com' as const,
  user: 'alice',
  generation: '00000000-0000-4000-8000-000000000001'
}

function fixture() {
  let repo: Repo = {
    id: 'repo-1',
    path: '/synthetic/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git'
  }
  const write = vi.fn(
    (
      target: Repo,
      path: string,
      addedAt: number,
      generation: string | null,
      binding: Repo['gitNetworkBinding'] | null
    ) => {
      if (
        target.id !== repo.id ||
        path !== repo.path ||
        addedAt !== repo.addedAt ||
        generation !== (repo.gitNetworkBinding?.generation ?? null)
      ) {
        throw new Error('stale owner')
      }
      repo = { ...repo, ...(binding ? { gitNetworkBinding: binding } : {}) }
      if (!binding) {
        delete repo.gitNetworkBinding
      }
      return repo
    }
  )
  const store = { setRepoGitNetworkBinding: write, getRepo: () => repo }
  const readHost = vi.fn(async () => 'gitlab.com')
  const controller = new RuntimeRepositorySettingsController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These cases exercise only the dedicated binding writer on the synthetic store.
    getStore: () => store as unknown as RuntimeStore,
    resolveRepo: async () => repo,
    forgetTerminalTopology: () => {},
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {},
    listGitLabNetworkProfiles: () => [gitlab],
    readGitNetworkRemoteHost: readHost,
    validateGitHubNetworkAccount: async () => true
  })
  return { controller, write, readHost }
}

describe.skipIf(process.platform === 'win32')('host-owned Git network binding action', () => {
  it('binds GitLab then atomically switches to a distinct GitHub account', async () => {
    const { controller, write, readHost } = fixture()
    const selected = await controller.bindGitLabNetworkProfile(
      'id:repo-1',
      gitlab.id,
      'origin',
      '/synthetic/repo'
    )
    expect(selected.gitNetworkBinding).toEqual({ provider: 'gitlab', ...gitlab })
    expect(readHost).toHaveBeenCalledTimes(2)
    readHost.mockResolvedValue('github.com')
    const next = await controller.bindGitHubNetworkAccount(
      'id:repo-1',
      { host: 'github.com', user: 'Bob' },
      'origin',
      '/synthetic/repo'
    )
    expect(next.gitNetworkBinding).toMatchObject({
      provider: 'github',
      host: 'github.com',
      user: 'Bob'
    })
    expect(next.gitNetworkBinding?.generation).not.toBe(gitlab.generation)
    expect(write).toHaveBeenLastCalledWith(
      selected,
      '/synthetic/repo',
      1,
      gitlab.generation,
      next.gitNetworkBinding
    )
  })

  it('refuses an expected-path or remote-host mismatch before any write', async () => {
    const { controller, write, readHost } = fixture()
    await expect(
      controller.bindGitLabNetworkProfile('id:repo-1', gitlab.id, 'origin', '/replaced')
    ).rejects.toThrow('repository changed')
    readHost.mockResolvedValue('github.com')
    await expect(
      controller.bindGitLabNetworkProfile('id:repo-1', gitlab.id, 'origin', '/synthetic/repo')
    ).rejects.toThrow('does not match')
    expect(write).not.toHaveBeenCalled()
  })
})
