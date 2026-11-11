import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { composeWorktreeId } from '../../../../shared/worktree/id'
import { gitExecFileAsync } from '../../../git/runner'
import {
  assertNoBoundGitProfileForUnsupportedOperation,
  boundGitLocalOperationForWorktree
} from './bound-git-local-operation'

const profile = {
  id: 'a'.repeat(64),
  host: 'gitlab.com',
  user: 'alice',
  generation: '00000000-0000-4000-8000-000000000001'
} as const
const binding = { provider: 'gitlab', ...profile } as const

describe.skipIf(process.platform === 'win32')('host-owned local bound Git operation', () => {
  it('binds one exact repo/worktree/profile and refuses stale replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-bound-git-owner-test-'))
    const repoPath = join(root, 'repo')
    try {
      await mkdir(join(repoPath, '.git'), { recursive: true })
      const repo: Repo = {
        id: 'repo-a',
        path: repoPath,
        displayName: 'A',
        badgeColor: '#000000',
        addedAt: 1,
        kind: 'git',
        gitNetworkBinding: binding
      }
      const rows = [repo]
      const store = { getRepos: () => rows, getAllWorktreeMeta: () => ({}) }
      const readToken = vi.fn(() => 'synthetic-token')
      const dependencies = {
        profileStore: { list: () => [profile], readToken },
        launcherPath: process.execPath
      }
      const args = {
        operation: 'fetch' as const,
        requestedPath: repoPath,
        resolvedPath: repoPath,
        worktreeId: composeWorktreeId(repo.id, repoPath),
        remoteName: 'origin'
      }
      const bound = await boundGitLocalOperationForWorktree(store, args, dependencies)
      expect(bound?.identity).toMatchObject({
        repoId: repo.id,
        worktreeId: args.worktreeId,
        worktreePath: repoPath,
        profileId: profile.id,
        profileGeneration: profile.generation,
        profileHost: profile.host
      })
      expect(await bound?.readCurrentIdentity()).toEqual(bound?.identity)
      expect(readToken).not.toHaveBeenCalled()
      rows[0] = { ...repo, addedAt: 2 }
      expect(await bound?.readCurrentIdentity()).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an old peer without worktree identity and ambiguous same-path owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-bound-git-old-peer-test-'))
    const repoPath = join(root, 'repo')
    try {
      await mkdir(join(repoPath, '.git'), { recursive: true })
      const repo: Repo = {
        id: 'repo-a',
        path: repoPath,
        displayName: 'A',
        badgeColor: '#000000',
        addedAt: 1,
        kind: 'git',
        gitNetworkBinding: binding
      }
      const rows = [repo]
      const store = { getRepos: () => rows, getAllWorktreeMeta: () => ({}) }
      const dependencies = {
        profileStore: { list: () => [profile], readToken: () => 'synthetic-token' },
        launcherPath: process.execPath
      }
      await expect(
        boundGitLocalOperationForWorktree(
          store,
          {
            operation: 'fetch',
            requestedPath: repoPath,
            resolvedPath: repoPath,
            remoteName: 'origin'
          },
          dependencies
        )
      ).rejects.toThrow('Selected Git network profile is unavailable')
      rows.push({ ...repo, id: 'repo-b' })
      await expect(
        boundGitLocalOperationForWorktree(
          store,
          {
            operation: 'fetch',
            requestedPath: repoPath,
            resolvedPath: repoPath,
            worktreeId: composeWorktreeId(repo.id, repoPath),
            remoteName: 'origin'
          },
          dependencies
        )
      ).rejects.toThrow('Selected Git network profile is unavailable')
      await expect(
        assertNoBoundGitProfileForUnsupportedOperation(store, repoPath, repoPath)
      ).rejects.toThrow('Selected Git network profile is unavailable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a symlink alias of a bound repository before an ambient Git command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-bound-git-alias-test-'))
    const repoPath = join(root, 'repo')
    const aliasPath = join(root, 'alias')
    try {
      await mkdir(join(repoPath, '.git'), { recursive: true })
      await symlink(repoPath, aliasPath)
      const repo: Repo = {
        id: 'repo-a',
        path: repoPath,
        displayName: 'A',
        badgeColor: '#000000',
        addedAt: 1,
        kind: 'git',
        gitNetworkBinding: binding
      }
      const store = { getRepos: () => [repo], getAllWorktreeMeta: () => ({}) }
      await expect(
        boundGitLocalOperationForWorktree(
          store,
          {
            operation: 'fetch',
            requestedPath: aliasPath,
            resolvedPath: aliasPath,
            worktreeId: composeWorktreeId('different-repo', aliasPath),
            remoteName: 'origin'
          },
          {
            profileStore: { list: () => [profile], readToken: () => 'synthetic-token' },
            launcherPath: process.execPath
          }
        )
      ).rejects.toThrow('Selected Git network profile is unavailable')
      await expect(
        assertNoBoundGitProfileForUnsupportedOperation(store, aliasPath, aliasPath)
      ).rejects.toThrow('Selected Git network profile is unavailable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects the configured non-origin upstream and push remote for bound operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-bound-git-remotes-test-'))
    const repoPath = join(root, 'repo')
    try {
      const env = {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0'
      }
      await gitExecFileAsync(['init', 'repo'], { cwd: root, env })
      for (const args of [
        ['remote', 'add', 'origin', 'https://gitlab.com/team/origin.git'],
        ['remote', 'add', 'review', 'https://gitlab.com/team/review.git'],
        ['symbolic-ref', 'HEAD', 'refs/heads/topic'],
        ['config', 'branch.topic.remote', 'review'],
        ['config', 'branch.topic.merge', 'refs/heads/topic'],
        ['config', 'branch.topic.pushRemote', 'review']
      ]) {
        await gitExecFileAsync(args, { cwd: repoPath, env })
      }
      await gitExecFileAsync(
        [
          '-c',
          'user.name=Synthetic',
          '-c',
          'user.email=synthetic@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'seed'
        ],
        { cwd: repoPath, env }
      )
      await gitExecFileAsync(['update-ref', 'refs/remotes/review/topic', 'HEAD'], {
        cwd: repoPath,
        env
      })
      const repo: Repo = {
        id: 'repo-a',
        path: repoPath,
        displayName: 'A',
        badgeColor: '#000000',
        addedAt: 1,
        kind: 'git',
        gitNetworkBinding: binding
      }
      const store = { getRepos: () => [repo], getAllWorktreeMeta: () => ({}) }
      const dependencies = {
        profileStore: { list: () => [profile], readToken: () => 'synthetic-token' },
        launcherPath: process.execPath
      }
      for (const operation of ['pull', 'push'] as const) {
        const bound = await boundGitLocalOperationForWorktree(
          store,
          {
            operation,
            requestedPath: repoPath,
            resolvedPath: repoPath,
            worktreeId: composeWorktreeId(repo.id, repoPath),
            remoteName: 'origin'
          },
          dependencies
        )
        expect(bound?.identity.remoteName).toBe('review')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps two GitHub network accounts distinct from legacy gh bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-bound-github-two-repos-'))
    try {
      const accounts = ['Alice', 'Bob'] as const
      const rows: Repo[] = []
      for (const user of accounts) {
        const repoPath = join(root, user)
        await mkdir(join(repoPath, '.git'), { recursive: true })
        rows.push({
          id: user,
          path: repoPath,
          displayName: user,
          badgeColor: '#000000',
          addedAt: 1,
          kind: 'git',
          ghAccount: { host: 'github.com', user: 'other' },
          gitNetworkBinding: {
            provider: 'github',
            host: 'github.com',
            user,
            generation: '00000000-0000-4000-8000-000000000001'
          }
        })
      }
      const store = { getRepos: () => rows, getAllWorktreeMeta: () => ({}) }
      const readGitHubToken = vi.fn(
        async (account: { host: string; user: string }) => `synthetic-${account.user}`
      )
      const available = new Set<string>(accounts)
      const validateGitHubAccount = vi.fn(async (account: { host: string; user: string }) =>
        available.has(account.user)
      )
      let aliceBound: Awaited<ReturnType<typeof boundGitLocalOperationForWorktree>> = null
      for (const repo of rows) {
        const bound = await boundGitLocalOperationForWorktree(
          store,
          {
            operation: 'fetch',
            requestedPath: repo.path,
            resolvedPath: repo.path,
            worktreeId: composeWorktreeId(repo.id, repo.path),
            remoteName: 'origin'
          },
          { launcherPath: process.execPath, readGitHubToken, validateGitHubAccount }
        )
        expect(bound?.identity.profileId).toBe(`github\0github.com\0${repo.id}`)
        expect(await bound?.readPassword()).toBe(`synthetic-${repo.id}`)
        expect(await bound?.readCurrentIdentity()).toEqual(bound?.identity)
        if (repo.id === 'Alice') {
          aliceBound = bound
        }
      }
      expect(readGitHubToken.mock.calls.map(([account]) => account.user)).toEqual(accounts)
      available.delete('Alice')
      expect(await aliceBound?.readCurrentIdentity()).toBeNull()
      available.add('Alice')
      rows[0] = {
        ...rows[0],
        gitNetworkBinding: {
          provider: 'github',
          host: 'github.com',
          user: 'Alice',
          generation: '00000000-0000-4000-8000-000000000002'
        }
      }
      expect(await aliceBound?.readCurrentIdentity()).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
