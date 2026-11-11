import { describe, expect, it, vi } from 'vitest'
import {
  createBoundGitOperationCredential,
  type BoundGitOperationRecord
} from './bound-git-operation-credential'

const baseRecord: BoundGitOperationRecord = {
  operation: 'fetch',
  repoId: 'repo-a',
  worktreeId: 'worktree-a',
  worktreePath: '/synthetic/a',
  commonGitDir: '/synthetic/a/.git',
  remoteName: 'origin',
  executionHostId: 'local',
  connectionGeneration: 'host-generation-1',
  profileId: 'gitlab-alice',
  profileGeneration: 'profile-generation-1',
  profileHost: 'gitlab.com',
  configFingerprint: 'config-version-1',
  remoteUrl: 'https://gitlab.com/team/a.git',
  username: 'alice',
  deadlineAtMs: 0
}

function record(): BoundGitOperationRecord {
  return { ...baseRecord, deadlineAtMs: Date.now() + 3000 }
}

async function ask(env: NodeJS.ProcessEnv, credential: object) {
  const url = env.ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT
  if (!url) {
    throw new Error('Synthetic endpoint missing')
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: env.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE, credential })
  })
}

describe('bound Git operation credential', () => {
  it('refuses an expired host record before opening an endpoint', async () => {
    const expired = { ...record(), deadlineAtMs: Date.now() - 1 }
    await expect(
      createBoundGitOperationCredential(
        expired,
        async () => expired,
        async () => 'synthetic-token',
        {}
      )
    ).rejects.toThrow('Bound Git operation expired.')
  })

  it('refuses a selected profile whose host differs from the remote before opening an endpoint', async () => {
    const wrongHost = { ...record(), profileHost: 'github.com' }
    await expect(
      createBoundGitOperationCredential(
        wrongHost,
        async () => wrongHost,
        async () => 'synthetic-token',
        {}
      )
    ).rejects.toThrow('Bound Git profile host does not match the remote.')
  })

  it('rechecks the operation record before reading a synthetic secret', async () => {
    const expected = record()
    const readCurrent = vi.fn(async () => expected)
    const readPassword = vi.fn(async () => 'synthetic-token')
    const endpoint = await createBoundGitOperationCredential(
      expected,
      readCurrent,
      readPassword,
      {}
    )
    try {
      const response = await ask(endpoint.env, {
        protocol: 'https',
        host: 'gitlab.com',
        path: 'team/a.git',
        username: 'alice'
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ username: 'alice', password: 'synthetic-token' })
      expect(readCurrent).toHaveBeenCalledTimes(2)
      expect(readPassword).toHaveBeenCalledOnce()
      await endpoint.closed
      await expect(
        ask(endpoint.env, {
          protocol: 'https',
          host: 'gitlab.com',
          path: 'team/a.git'
        })
      ).rejects.toThrow()
    } finally {
      await endpoint.close()
    }
  })

  it.each([
    ['neighbor repo', { repoId: 'repo-b' }],
    ['neighbor worktree', { worktreeId: 'worktree-b' }],
    ['moved worktree', { worktreePath: '/synthetic/b' }],
    ['rotated profile', { profileGeneration: 'profile-generation-2' }],
    ['changed profile host', { profileHost: 'github.com' }],
    ['changed host', { connectionGeneration: 'host-generation-2' }],
    ['changed config', { configFingerprint: 'config-version-2' }],
    ['changed remote', { remoteUrl: 'https://gitlab.com/team/b.git' }],
    ['changed remote name', { remoteName: 'upstream' }],
    ['changed deadline', { deadlineAtMs: 0 }]
  ])('refuses %s before reading the token', async (_reason, change) => {
    const expected = record()
    const current = { ...expected, ...change }
    const readPassword = vi.fn(async () => 'synthetic-token')
    const endpoint = await createBoundGitOperationCredential(
      expected,
      async () => current,
      readPassword,
      {}
    )
    try {
      const response = await ask(endpoint.env, {
        protocol: 'https',
        host: 'gitlab.com',
        path: 'team/a.git'
      })
      expect(response.status).toBe(403)
      expect(readPassword).not.toHaveBeenCalled()
      await endpoint.closed
    } finally {
      await endpoint.close()
    }
  })

  it('refuses a credential path or username mismatch without calling the host', async () => {
    const expected = record()
    const readCurrent = vi.fn(async () => expected)
    const endpoint = await createBoundGitOperationCredential(
      expected,
      readCurrent,
      async () => 'synthetic-token',
      {}
    )
    try {
      const response = await ask(endpoint.env, {
        protocol: 'https',
        host: 'gitlab.com',
        path: 'team/b.git',
        username: 'bob'
      })
      expect(response.status).toBe(403)
      expect(readCurrent).not.toHaveBeenCalled()
    } finally {
      await endpoint.close()
    }
  })

  it('refuses a profile rotation while the synthetic token is being read', async () => {
    const expected = record()
    let current = expected
    const endpoint = await createBoundGitOperationCredential(
      expected,
      async () => current,
      async () => {
        current = { ...expected, profileGeneration: 'profile-generation-2' }
        return 'synthetic-token'
      },
      {}
    )
    try {
      const response = await ask(endpoint.env, {
        protocol: 'https',
        host: 'gitlab.com',
        path: 'team/a.git'
      })
      expect(response.status).toBe(403)
      await endpoint.closed
    } finally {
      await endpoint.close()
    }
  })

  it('refuses an in-place mutation of the caller record during token read', async () => {
    const mutable = record()
    const endpoint = await createBoundGitOperationCredential(
      mutable,
      async () => mutable,
      async () => {
        mutable.configFingerprint = 'changed-in-place'
        return 'synthetic-token'
      },
      {}
    )
    try {
      const response = await ask(endpoint.env, {
        protocol: 'https',
        host: 'gitlab.com',
        path: 'team/a.git'
      })
      expect(response.status).toBe(403)
      await endpoint.closed
    } finally {
      await endpoint.close()
    }
  })

  it('keeps two synthetic repositories and profile tokens in separate one-use endpoints', async () => {
    const first = record()
    const second = {
      ...record(),
      repoId: 'repo-b',
      worktreeId: 'worktree-b',
      worktreePath: '/synthetic/b',
      commonGitDir: '/synthetic/b/.git',
      profileId: 'gitlab-bob',
      remoteUrl: 'https://gitlab.com/team/b.git',
      username: 'bob'
    }
    const firstEndpoint = await createBoundGitOperationCredential(
      first,
      async () => first,
      async () => 'token-a',
      {}
    )
    const secondEndpoint = await createBoundGitOperationCredential(
      second,
      async () => second,
      async () => 'token-b',
      {}
    )
    try {
      const [firstReply, secondReply] = await Promise.all([
        ask(firstEndpoint.env, { protocol: 'https', host: 'gitlab.com', path: 'team/a.git' }),
        ask(secondEndpoint.env, { protocol: 'https', host: 'gitlab.com', path: 'team/b.git' })
      ])
      expect(await firstReply.json()).toEqual({ username: 'alice', password: 'token-a' })
      expect(await secondReply.json()).toEqual({ username: 'bob', password: 'token-b' })
      const cross = await createBoundGitOperationCredential(
        first,
        async () => first,
        async () => 'token-a',
        {}
      )
      try {
        expect(
          (await ask(cross.env, { protocol: 'https', host: 'gitlab.com', path: 'team/b.git' }))
            .status
        ).toBe(403)
      } finally {
        await cross.close()
      }
    } finally {
      await Promise.all([firstEndpoint.close(), secondEndpoint.close()])
    }
  })
})
