import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { RepoUpdatePersistenceOperations } from './repo-update-operations'
import { hydrateRepo } from './repo-hydration'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: '/repos/example',
    displayName: 'Example',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

function makeOperations(repos: Repo[]) {
  const state = { repos, projectGroups: [], worktreeMeta: {} }
  const scheduleSave = vi.fn()
  const operations = new RepoUpdatePersistenceOperations({
    state,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    syncProjectHostSetupCompatibilityState: vi.fn(),
    scheduleSave,
    hydrateRepo: (repo) => repo
  })
  return { operations, scheduleSave, state }
}

const syntheticGitLabProfile = {
  provider: 'gitlab',
  id: 'a'.repeat(64),
  host: 'gitlab.com',
  user: 'alice',
  generation: '00000000-0000-4000-8000-000000000001'
} as const

describe('updateRepo host guard', () => {
  let errors: string[]

  beforeEach(() => {
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  })

  it('reports a host mismatch instead of returning the same silent null as a missing row', () => {
    // #22421's exact shape: the row exists under `runtime:env-1`, the caller addressed the probe host.
    const { operations, scheduleSave } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    const result = operations.updateRepo(
      { id: 'repo-1', executionHostId: 'local' },
      { displayName: 'Renamed' }
    )

    expect(result).toBeNull()
    expect(scheduleSave).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('repo-1')
    expect(errors[0]).toContain('requested host local')
    expect(errors[0]).toContain('runtime:env-1')
  })

  it('stays silent when the row genuinely does not exist', () => {
    const { operations } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    expect(
      operations.updateRepo(
        { id: 'repo-missing', executionHostId: 'local' },
        { displayName: 'Renamed' }
      )
    ).toBeNull()
    expect(errors).toEqual([])
  })

  it('writes when the host argument matches the row stamp', () => {
    const { operations, scheduleSave, state } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    const result = operations.updateRepo(
      { id: 'repo-1', executionHostId: 'runtime:env-1' },
      { displayName: 'Renamed' }
    )

    expect(result?.displayName).toBe('Renamed')
    expect(state.repos[0].displayName).toBe('Renamed')
    expect(scheduleSave).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('still refuses a cross-host write when both hosts hold a row with the same id', () => {
    const local = makeRepo({ id: 'repo-1', displayName: 'Local', executionHostId: 'local' })
    const peer = makeRepo({ id: 'repo-1', displayName: 'Peer', executionHostId: 'ssh:peer' })
    const { operations, state } = makeOperations([local, peer])

    const result = operations.updateRepo(
      { id: 'repo-1', executionHostId: 'local' },
      { displayName: 'Local edit' }
    )

    expect(result?.displayName).toBe('Local edit')
    // The peer's row is untouched: a client-local write must never repair another host's metadata.
    expect(state.repos[1].displayName).toBe('Peer')
  })

  it('reads a target without host fields as the local row, never the first same-id row', () => {
    const peer = makeRepo({ id: 'repo-1', displayName: 'Peer', connectionId: 'peer' })
    const local = makeRepo({ id: 'repo-1', displayName: 'Local' })
    const { operations, state } = makeOperations([peer, local])

    operations.updateRepo({ id: 'repo-1' }, { displayName: 'Renamed' })

    expect(state.repos.map((repo) => repo.displayName)).toEqual(['Peer', 'Renamed'])
  })

  it('addresses an SSH row through its connectionId alone', () => {
    const local = makeRepo({ id: 'repo-1', displayName: 'Local' })
    const peer = makeRepo({ id: 'repo-1', displayName: 'Peer', connectionId: 'peer' })
    const { operations, state } = makeOperations([local, peer])

    operations.updateRepo(peer, { displayName: 'Peer edit' })

    expect(state.repos.map((repo) => repo.displayName)).toEqual(['Local', 'Peer edit'])
    expect(errors).toEqual([])
  })

  it('drops a forged profile field from ordinary repo updates', () => {
    const repo = makeRepo({ id: 'repo-1' })
    const { operations, state } = makeOperations([repo])
    const forged = { displayName: 'Renamed', gitNetworkBinding: syntheticGitLabProfile }

    operations.updateRepo(repo, forged)

    expect(state.repos[0].displayName).toBe('Renamed')
    expect(state.repos[0].gitNetworkBinding).toBeUndefined()
  })

  it('writes only a current local Git row through the dedicated binding path', () => {
    const repo = makeRepo({ id: 'repo-1' })
    const { operations, scheduleSave, state } = makeOperations([repo])
    const untrustedExtra = { ...syntheticGitLabProfile, token: 'synthetic-must-not-persist' }

    const bound = operations.setRepoGitNetworkBinding(
      repo,
      repo.path,
      repo.addedAt,
      null,
      untrustedExtra
    )
    expect(bound.gitNetworkBinding).toEqual(syntheticGitLabProfile)
    expect(state.repos[0].gitNetworkBinding).toEqual(syntheticGitLabProfile)
    expect(Object.keys(state.repos[0].gitNetworkBinding ?? {}).sort()).toEqual([
      'generation',
      'host',
      'id',
      'provider',
      'user'
    ])
    expect(scheduleSave).toHaveBeenCalledOnce()
    expect(() =>
      operations.setRepoGitNetworkBinding(
        repo,
        repo.path,
        repo.addedAt,
        null,
        syntheticGitLabProfile
      )
    ).toThrow('Git network binding unavailable for this repository.')
    expect(scheduleSave).toHaveBeenCalledOnce()
  })

  it('atomically switches GitLab to GitHub network identity without changing legacy gh binding', () => {
    const repo = makeRepo({
      id: 'repo-switch',
      ghAccount: { host: 'github.com', user: 'legacy' }
    })
    const { operations, state } = makeOperations([repo])
    operations.setRepoGitNetworkBinding(repo, repo.path, repo.addedAt, null, syntheticGitLabProfile)
    const github = {
      provider: 'github',
      host: 'github.com',
      user: 'Alice',
      generation: '00000000-0000-4000-8000-000000000002'
    } as const
    const switched = operations.setRepoGitNetworkBinding(
      repo,
      repo.path,
      repo.addedAt,
      syntheticGitLabProfile.generation,
      github
    )
    expect(switched.gitNetworkBinding).toEqual(github)
    expect(state.repos[0].gitNetworkBinding).toEqual(github)
    expect(state.repos[0].ghAccount).toEqual({ host: 'github.com', user: 'legacy' })
    expect(() =>
      operations.setRepoGitNetworkBinding(
        repo,
        repo.path,
        repo.addedAt,
        syntheticGitLabProfile.generation,
        null
      )
    ).toThrow('Git network binding unavailable for this repository.')
  })

  it('refuses a host, folder or path mismatch without persisting a binding', () => {
    const peer = makeRepo({ id: 'repo-1', executionHostId: 'ssh:peer' })
    const folder = makeRepo({ id: 'repo-2', kind: 'folder' })
    const local = makeRepo({ id: 'repo-3' })
    const { operations, scheduleSave } = makeOperations([peer, folder, local])

    for (const [repo, path] of [
      [peer, peer.path],
      [folder, folder.path],
      [local, '/different/path']
    ] as const) {
      expect(() =>
        operations.setRepoGitNetworkBinding(repo, path, repo.addedAt, null, syntheticGitLabProfile)
      ).toThrow('Git network binding unavailable for this repository.')
    }
    expect(scheduleSave).not.toHaveBeenCalled()
  })

  it('refuses a deleted and recreated row at the same host and path', () => {
    const original = makeRepo({ id: 'repo-1', addedAt: 1 })
    const replacement = makeRepo({ id: 'repo-1', addedAt: 2 })
    const { operations, scheduleSave } = makeOperations([replacement])

    expect(() =>
      operations.setRepoGitNetworkBinding(
        original,
        original.path,
        original.addedAt,
        null,
        syntheticGitLabProfile
      )
    ).toThrow('Git network binding unavailable for this repository.')
    expect(scheduleSave).not.toHaveBeenCalled()
  })

  it('hydrates only token-free profile metadata from a persisted row', () => {
    const rawProfile = { ...syntheticGitLabProfile, token: 'synthetic-must-not-project' }
    const raw = makeRepo({
      id: 'repo-1',
      gitNetworkBinding: rawProfile
    })
    const hydrated = hydrateRepo(raw, new Map())
    expect(hydrated.gitNetworkBinding).toEqual(syntheticGitLabProfile)
    expect(Object.keys(hydrated.gitNetworkBinding ?? {}).sort()).toEqual([
      'generation',
      'host',
      'id',
      'provider',
      'user'
    ])
  })
})
