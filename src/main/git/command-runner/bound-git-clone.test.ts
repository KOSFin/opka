import { access, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GitLabNetworkProfile } from '../../../shared/gitlab-network-profile'
import { prepareBoundGitClone } from './bound-git-clone'
import {
  validateBoundGitCloneSelection,
  type BoundGitCloneSelectionDependencies
} from './bound-git-clone-selection'

const profile = {
  id: 'a'.repeat(64),
  host: 'gitlab.com',
  user: 'alice',
  generation: '00000000-0000-4000-8000-000000000001'
} as const

async function fixture() {
  const destination = await mkdtemp(join(tmpdir(), 'orca-bound-clone-test-'))
  const clonePath = join(destination, 'repo')
  await mkdir(clonePath)
  const stats = await lstat(clonePath)
  return {
    destination,
    clonePath,
    claimedTarget: {
      canCleanup: true,
      ownedDirectoryIdentity: {
        dev: stats.dev,
        ino: stats.ino,
        birthtimeMs: stats.birthtimeMs
      }
    }
  }
}

async function requestCredential(env: NodeJS.ProcessEnv, host = 'gitlab.com', username = 'alice') {
  return fetch(env.ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT ?? '', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nonce: env.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE,
      credential: {
        protocol: 'https',
        host,
        path: 'team/repo.git',
        username
      }
    })
  })
}

async function expectCredentialDenied(env: NodeJS.ProcessEnv, host = 'gitlab.com'): Promise<void> {
  const response = await requestCredential(env, host).catch((error: unknown) => {
    if (error instanceof Error && /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET/.test(error.message)) {
      return null
    }
    throw error
  })
  if (response) {
    expect(response.status).not.toBe(200)
  }
}

async function prepareGitLabClone(
  target: Awaited<ReturnType<typeof fixture>>,
  dependencies: BoundGitCloneSelectionDependencies,
  url = 'https://gitlab.com/team/repo.git'
) {
  const selection = await validateBoundGitCloneSelection(
    url,
    { provider: 'gitlab', profileId: profile.id },
    dependencies
  )
  return prepareBoundGitClone({ ...target, url, selection })
}

describe.skipIf(process.platform === 'win32')('bound GitLab clone credential', () => {
  it('binds only the selected self-hosted authority and port', async () => {
    const target = await fixture()
    const privateProfile = { ...profile, host: 'gitlab.example:8443' }
    const selection = await validateBoundGitCloneSelection(
      'https://gitlab.example:8443/team/repo.git',
      { provider: 'gitlab', profileId: privateProfile.id },
      {
        profileStore: { list: () => [privateProfile], readToken: () => 'synthetic-token' },
        launcherPath: process.execPath
      }
    )
    const clone = await prepareBoundGitClone({
      ...target,
      url: 'https://gitlab.example:8443/team/repo.git',
      selection
    })
    try {
      expect((await requestCredential(clone.env, 'gitlab.example:8443')).status).toBe(200)
      await expectCredentialDenied(clone.env, 'gitlab.example')
    } finally {
      await clone.close()
      await rm(target.destination, { recursive: true, force: true })
    }
  })

  it('refuses credentials and final success after cancellation', async () => {
    const target = await fixture()
    const controller = new AbortController()
    const selection = await validateBoundGitCloneSelection(
      'https://gitlab.com/team/repo.git',
      { provider: 'gitlab', profileId: profile.id },
      {
        profileStore: { list: () => [profile], readToken: () => 'synthetic-token' },
        launcherPath: process.execPath
      }
    )
    const clone = await prepareBoundGitClone({
      ...target,
      url: 'https://gitlab.com/team/repo.git',
      selection,
      signal: controller.signal
    })
    try {
      controller.abort()
      await expect(clone.assertCurrent()).rejects.toThrow(/unavailable/)
      await expectCredentialDenied(clone.env)
    } finally {
      await clone.close()
      await rm(target.destination, { recursive: true, force: true })
    }
  })

  it('uses one selected profile with no ambient credential and no token before matching request', async () => {
    const target = await fixture()
    const readToken = vi.fn(() => 'synthetic-token')
    const dependencies = {
      profileStore: { list: () => [profile], readToken },
      launcherPath: process.execPath
    }
    try {
      const clone = await prepareGitLabClone(target, dependencies)
      try {
        expect(clone.args).toEqual(
          expect.arrayContaining([
            '-c',
            'credential.helper=',
            'clone',
            '--progress',
            '--',
            'https://gitlab.com/team/repo.git',
            target.clonePath
          ])
        )
        expect(clone.env.HOME).not.toBe(process.env.HOME)
        expect(clone.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
        expect(clone.env.GIT_TERMINAL_PROMPT).toBe('0')
        expect(readToken).not.toHaveBeenCalled()
        const response = await requestCredential(clone.env)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ username: 'alice', password: 'synthetic-token' })
        expect(readToken).toHaveBeenCalledOnce()
      } finally {
        const home = clone.env.HOME
        await clone.close()
        if (home) {
          await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
    } finally {
      await rm(target.destination, { recursive: true, force: true })
    }
  })

  it('refuses wrong host, alternate port and profile rotation before revealing a token', async () => {
    const target = await fixture()
    let activeProfile: GitLabNetworkProfile = profile
    const readToken = vi.fn(() => 'synthetic-token')
    const dependencies = {
      profileStore: { list: () => [activeProfile], readToken },
      launcherPath: process.execPath
    }
    try {
      for (const url of [
        'https://example.com/team/repo.git',
        'https://gitlab.com:444/team/repo.git'
      ]) {
        await expect(
          validateBoundGitCloneSelection(
            url,
            { provider: 'gitlab', profileId: profile.id },
            dependencies
          )
        ).rejects.toThrow('Selected Git network profile is unavailable')
      }
      const clone = await prepareGitLabClone(target, dependencies)
      try {
        activeProfile = { ...profile, generation: '00000000-0000-4000-8000-000000000002' }
        await expect(clone.assertCurrent()).rejects.toThrow(
          'Selected Git network profile is unavailable'
        )
        expect((await requestCredential(clone.env)).status).not.toBe(200)
        expect(readToken).not.toHaveBeenCalled()
      } finally {
        await clone.close()
      }
    } finally {
      await rm(target.destination, { recursive: true, force: true })
    }
  })

  it('refuses a replaced destination and preserves its replacement', async () => {
    const target = await fixture()
    const clone = await prepareGitLabClone(target, {
      profileStore: { list: () => [profile], readToken: () => 'synthetic-token' },
      launcherPath: process.execPath
    })
    try {
      await rename(target.clonePath, join(target.destination, 'moved'))
      await mkdir(target.clonePath)
      await expect(clone.assertCurrent()).rejects.toThrow(
        'Selected Git network profile is unavailable'
      )
      expect((await requestCredential(clone.env)).status).not.toBe(200)
      await expect(access(target.clonePath)).resolves.toBeUndefined()
    } finally {
      await clone.close()
      await rm(target.destination, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('bound GitHub clone selection', () => {
  it('keeps two selected existing accounts isolated and refuses a removed login', async () => {
    const alice = await fixture()
    const bob = await fixture()
    const available = new Set(['Alice', 'Bob'])
    const validateGitHubAccount = vi.fn(async (account: { host: string; user: string }) =>
      available.has(account.user)
    )
    const readGitHubToken = vi.fn(
      async (account: { host: string; user: string }) => `synthetic-${account.user}`
    )
    const dependencies = {
      launcherPath: process.execPath,
      validateGitHubAccount,
      readGitHubToken
    }
    const url = 'https://github.com/team/repo.git'
    try {
      const aliceSelection = await validateBoundGitCloneSelection(
        url,
        { provider: 'github', host: 'github.com', user: 'Alice' },
        dependencies
      )
      const bobSelection = await validateBoundGitCloneSelection(
        url,
        { provider: 'github', host: 'github.com', user: 'Bob' },
        dependencies
      )
      const aliceClone = await prepareBoundGitClone({ ...alice, url, selection: aliceSelection })
      const bobClone = await prepareBoundGitClone({ ...bob, url, selection: bobSelection })
      try {
        expect(aliceClone.binding.provider).toBe('github')
        expect(bobClone.binding.provider).toBe('github')
        expect(readGitHubToken).not.toHaveBeenCalled()
        const aliceReply = await requestCredential(aliceClone.env, 'github.com', 'Alice')
        expect(await aliceReply.json()).toEqual({ username: 'Alice', password: 'synthetic-Alice' })
        const wrongAccount = await requestCredential(bobClone.env, 'github.com', 'Alice')
        expect(wrongAccount.status).not.toBe(200)
        expect(readGitHubToken).toHaveBeenCalledTimes(1)
        const bobRetry = await prepareBoundGitClone({ ...bob, url, selection: bobSelection })
        available.delete('Bob')
        try {
          expect((await requestCredential(bobRetry.env, 'github.com', 'Bob')).status).not.toBe(200)
        } finally {
          await bobRetry.close()
        }
        expect(readGitHubToken).toHaveBeenCalledTimes(1)
      } finally {
        await aliceClone.close()
        await bobClone.close()
      }
    } finally {
      await rm(alice.destination, { recursive: true, force: true })
      await rm(bob.destination, { recursive: true, force: true })
    }
  })
})
