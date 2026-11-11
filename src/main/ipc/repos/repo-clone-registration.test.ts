import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence'
import { registerLocalClonedRepo } from './repo-clone-registration'

const { detect, prepare } = vi.hoisted(() => ({ detect: vi.fn(), prepare: vi.fn() }))
vi.mock('../../repo-icon-autodetect', () => ({ detectRepoIconAndUpstream: detect }))
vi.mock('../../worktree-root-preparation', () => ({ prepareLocalWorktreeRootForRepo: prepare }))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))
vi.mock('./repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))

const binding = {
  provider: 'gitlab' as const,
  id: 'a'.repeat(64),
  host: 'gitlab.com',
  user: 'alice',
  generation: '00000000-0000-4000-8000-000000000001'
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function fixture() {
  const repos: Repo[] = []
  let flush = Promise.resolve()
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((entry) => entry.id === id),
    getAllWorktreeMeta: () => ({}),
    addRepo: (repo: Repo) => {
      repos.push(repo)
    },
    setRepoGitNetworkBinding: (repo: Repo) => {
      const bound = { ...repo, gitNetworkBinding: binding }
      repos.splice(
        repos.findIndex((entry) => entry.id === repo.id),
        1,
        bound
      )
      return bound
    },
    flushPendingOrThrowAsync: () => flush,
    removeProjectForHost: (repo: Repo) => {
      const index = repos.findIndex((entry) => entry.id === repo.id)
      if (index !== -1) {
        repos.splice(index, 1)
      }
    }
  }
  let current = true
  const boundClone = {
    args: [],
    env: {},
    binding,
    assertCurrent: vi.fn(async () => {
      if (!current) {
        throw new Error('Profile changed')
      }
    }),
    close: vi.fn(async () => {})
  }
  const findSaved = (): Repo | undefined => repos.find((repo) => repo.path === '/fixture/repo')
  const run = () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration uses only the fake store methods above.
    const typedStore = store as unknown as Store
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: notification is mocked, so registration does not dereference the window.
    const window = {} as BrowserWindow
    return registerLocalClonedRepo(window, typedStore, '/fixture/repo', findSaved, boundClone)
  }
  return {
    repos,
    store,
    boundClone,
    run,
    setCurrent: (value: boolean) => {
      current = value
    },
    setFlush: (value: Promise<void>) => {
      flush = value
    }
  }
}

describe('bound clone registration final success fences', () => {
  it('refuses a profile removed during icon detection before publishing a row', async () => {
    const held = deferred()
    detect.mockImplementationOnce(async () => {
      await held.promise
      return {}
    })
    prepare.mockResolvedValue(undefined)
    const f = fixture()
    const pending = f.run()
    await vi.waitFor(() => expect(detect).toHaveBeenCalled())
    f.setCurrent(false)
    held.release()
    await expect(pending).rejects.toThrow('Profile changed')
    expect(f.repos).toEqual([])
  })

  it('rolls back only its own row when a profile rotates during durable flush', async () => {
    const held = deferred()
    detect.mockResolvedValueOnce({})
    prepare.mockResolvedValue(undefined)
    const f = fixture()
    f.setFlush(held.promise)
    const pending = f.run()
    await vi.waitFor(() => expect(f.repos[0]?.gitNetworkBinding).toEqual(binding))
    f.setCurrent(false)
    held.release()
    await expect(pending).rejects.toThrow('Profile changed')
    expect(f.repos).toEqual([])
  })

  it('preserves another generation replacing the row during durable flush', async () => {
    const held = deferred()
    detect.mockResolvedValueOnce({})
    prepare.mockResolvedValue(undefined)
    const f = fixture()
    f.setFlush(held.promise)
    const pending = f.run()
    await vi.waitFor(() => expect(f.repos[0]?.gitNetworkBinding).toEqual(binding))
    const replacement = {
      ...f.repos[0],
      gitNetworkBinding: { ...binding, generation: '00000000-0000-4000-8000-000000000002' }
    }
    f.repos.splice(0, 1, replacement)
    f.setCurrent(false)
    held.release()
    await expect(pending).rejects.toThrow('Profile changed')
    expect(f.repos).toEqual([replacement])
  })
})
