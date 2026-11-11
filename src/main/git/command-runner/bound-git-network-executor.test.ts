import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBoundGitNetworkCommand } from './bound-git-network-executor'
import type { BoundGitOwnerIdentity } from './bound-git-operation-credential'
import {
  _resetGitAdmissionForTests,
  acquireGitAdmission,
  GitAdmissionScheduler
} from './git-subprocess-admission'
import { runWithGitFetchHeadLock } from '../../../shared/git-fetch-head-lock'
import { runWithGitWorktreeOperationLock } from '../../../shared/git-worktree-operation-lock'

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('./exec-file-capture', () => ({ execFileCaptureToTermination: capture }))

const CONFIG = Buffer.from(
  'core.repositoryformatversion\n0\0remote.origin.url\nhttps://gitlab.com/team/a.git\0'
)
const REMOTE = Buffer.from('https://gitlab.com/team/a.git\n')
const SYNTHETIC_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin' }

async function requestCredential(env: NodeJS.ProcessEnv, path = 'team/a.git'): Promise<unknown> {
  const endpoint = env.ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT
  const nonce = env.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE
  if (!endpoint || !nonce) {
    throw new Error('Synthetic endpoint unavailable')
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nonce,
      credential: { protocol: 'https', host: 'gitlab.com', path }
    })
  })
  return response.ok ? response.json() : null
}

function boundIdentity(): BoundGitOwnerIdentity {
  return {
    operation: 'push',
    repoId: 'repo-a',
    worktreeId: 'worktree-a',
    worktreePath: '/synthetic/a',
    commonGitDir: '/synthetic/a/.git',
    remoteName: 'origin',
    executionHostId: 'local',
    connectionGeneration: 'generation-1',
    profileId: 'gitlab-alice',
    profileGeneration: 'profile-1',
    profileHost: 'gitlab.com',
    username: 'alice'
  }
}

afterEach(() => {
  capture.mockReset()
  _resetGitAdmissionForTests()
})

describe.skipIf(process.platform === 'win32')('bound Git network executor', () => {
  it('uses admission, exact local target and the private one-use helper', async () => {
    const identity = boundIdentity()
    const readPassword = vi.fn(async () => 'synthetic-token')
    capture.mockImplementation(
      async (
        _command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; terminationBarrier?: boolean }
      ) => {
        if (args[0] === 'config') {
          return { stdout: CONFIG, stderr: Buffer.alloc(0) }
        }
        if (args[0] === 'remote') {
          return { stdout: REMOTE, stderr: Buffer.alloc(0) }
        }
        const response = await requestCredential(options.env)
        expect(response).toEqual({ username: 'alice', password: 'synthetic-token' })
        expect(options.env.GITHUB_TOKEN).toBeUndefined()
        expect(options.terminationBarrier).toBe(true)
        return { stdout: '', stderr: '' }
      }
    )
    const output = await runBoundGitNetworkCommand(
      ['push', '--set-upstream', 'origin', 'HEAD:main'],
      { cwd: '/synthetic/a', env: { ...SYNTHETIC_ENV, GITHUB_TOKEN: 'synthetic-ambient-secret' } },
      {
        identity,
        launcherPath: process.execPath,
        readCurrentIdentity: async () => identity,
        readPassword
      }
    )
    expect(output).toEqual({ stdout: '', stderr: '' })
    expect(readPassword).toHaveBeenCalledOnce()
    expect(capture.mock.calls.map((call) => call[1][0])).toEqual([
      'config',
      'remote',
      'config',
      'remote',
      '-c',
      'config',
      'remote',
      'config',
      'remote'
    ])
  })

  it('keeps two same-host users in separate repository credential children', async () => {
    const a = boundIdentity()
    const b: BoundGitOwnerIdentity = {
      ...a,
      repoId: 'repo-b',
      worktreeId: 'worktree-b',
      worktreePath: '/synthetic/b',
      commonGitDir: '/synthetic/b/.git',
      profileId: 'gitlab-bob',
      profileGeneration: 'profile-2',
      username: 'bob'
    }
    const readA = vi.fn(async () => 'token-a')
    const readB = vi.fn(async () => 'token-b')
    const childCredentials: unknown[] = []
    capture.mockImplementation(
      async (
        _command: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv }
      ) => {
        expect([a.worktreePath, b.worktreePath]).toContain(options.cwd)
        const repo = options.cwd === a.worktreePath ? 'a' : 'b'
        const remote = `https://gitlab.com/team/${repo}.git`
        if (args[0] === 'config') {
          return {
            stdout: Buffer.from(`core.repositoryformatversion\n0\0remote.origin.url\n${remote}\0`),
            stderr: Buffer.alloc(0)
          }
        }
        if (args[0] === 'remote') {
          return { stdout: Buffer.from(`${remote}\n`), stderr: Buffer.alloc(0) }
        }
        const credential = await requestCredential(options.env, `team/${repo}.git`)
        childCredentials.push(credential)
        expect(options.env.GITHUB_TOKEN).toBeUndefined()
        return { stdout: '', stderr: '' }
      }
    )
    for (const [identity, readPassword] of [
      [a, readA],
      [b, readB]
    ] as const) {
      if (!identity.worktreePath) {
        throw new Error('Synthetic fixture requires a worktree path')
      }
      await runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        { cwd: identity.worktreePath, env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword
        }
      )
    }
    expect(childCredentials).toEqual([
      { username: 'alice', password: 'token-a' },
      { username: 'bob', password: 'token-b' }
    ])
    expect(readA).toHaveBeenCalledOnce()
    expect(readB).toHaveBeenCalledOnce()
  })

  it('refuses a local config change at helper get before reading the token', async () => {
    const identity = boundIdentity()
    const readPassword = vi.fn(async () => 'synthetic-token')
    let configReads = 0
    capture.mockImplementation(
      async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (args[0] === 'config') {
          configReads += 1
          return {
            stdout:
              configReads <= 2 ? CONFIG : Buffer.from('http.extraheader\nAuthorization: other\0'),
            stderr: Buffer.alloc(0)
          }
        }
        if (args[0] === 'remote') {
          return { stdout: REMOTE, stderr: Buffer.alloc(0) }
        }
        if ((await requestCredential(options.env)) === null) {
          throw new Error('Synthetic Git child refused denied credentials')
        }
        return { stdout: '', stderr: '' }
      }
    )
    await expect(
      runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        { cwd: '/synthetic/a', env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword
        }
      )
    ).rejects.toThrow('Bound Git operation unavailable.')
    expect(configReads).toBeGreaterThanOrEqual(3)
    expect(readPassword).not.toHaveBeenCalled()
  })

  it('refuses a worktree config header that a local-only preflight would miss', async () => {
    const identity = boundIdentity()
    const readPassword = vi.fn(async () => 'synthetic-token')
    capture.mockImplementation(
      async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (args[0] === 'config') {
          return {
            stdout: args.includes('--local')
              ? CONFIG
              : Buffer.from(
                  'http.https://gitlab.com/.extraheader\nAuthorization: synthetic-worktree-header\0'
                ),
            stderr: Buffer.alloc(0)
          }
        }
        if (args[0] === 'remote') {
          return { stdout: REMOTE, stderr: Buffer.alloc(0) }
        }
        await requestCredential(options.env)
        return { stdout: '', stderr: '' }
      }
    )
    await expect(
      runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        { cwd: '/synthetic/a', env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword
        }
      )
    ).rejects.toThrow('Bound Git operation unavailable.')
    expect(readPassword).not.toHaveBeenCalled()
  })

  it('refuses a remote outside the selected profile host before opening a credential endpoint', async () => {
    const identity = { ...boundIdentity(), profileHost: 'github.com' }
    const readPassword = vi.fn(async () => 'synthetic-token')
    capture.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'config') {
        return { stdout: CONFIG, stderr: Buffer.alloc(0) }
      }
      if (args[0] === 'remote') {
        return { stdout: REMOTE, stderr: Buffer.alloc(0) }
      }
      throw new Error('Unexpected child network command')
    })
    await expect(
      runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        { cwd: '/synthetic/a', env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword
        }
      )
    ).rejects.toThrow('Bound Git operation unavailable.')
    expect(readPassword).not.toHaveBeenCalled()
    expect(capture.mock.calls.every((call) => ['config', 'remote'].includes(call[1][0]))).toBe(true)
  })

  it('refuses a worktree config change during token resolution', async () => {
    const identity = boundIdentity()
    let worktreeHeader = false
    const readPassword = vi.fn(async () => {
      worktreeHeader = true
      return 'synthetic-token'
    })
    capture.mockImplementation(
      async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (args[0] === 'config') {
          return {
            stdout:
              worktreeHeader && !args.includes('--local')
                ? Buffer.from(
                    'http.https://gitlab.com/.extraheader\nAuthorization: synthetic-late-header\0'
                  )
                : CONFIG,
            stderr: Buffer.alloc(0)
          }
        }
        if (args[0] === 'remote') {
          return { stdout: REMOTE, stderr: Buffer.alloc(0) }
        }
        if ((await requestCredential(options.env)) === null) {
          throw new Error('Synthetic credential refused')
        }
        return { stdout: '', stderr: '' }
      }
    )
    await expect(
      runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        { cwd: '/synthetic/a', env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword
        }
      )
    ).rejects.toThrow('Bound Git operation unavailable.')
    expect(readPassword).toHaveBeenCalledOnce()
  })

  it('isolates synthetic ambient netrc and removes the child home after termination', async () => {
    const ambientHome = await mkdtemp(join(tmpdir(), 'orca-bound-git-ambient-test-'))
    const identity = boundIdentity()
    let childHome: string | undefined
    try {
      await writeFile(
        join(ambientHome, '.netrc'),
        'machine gitlab.com login ambient password synthetic-secret\n'
      )
      capture.mockImplementation(
        async (
          _command: string,
          args: string[],
          options: { env: NodeJS.ProcessEnv; terminationBarrier?: boolean }
        ) => {
          if (args[0] === 'config') {
            return { stdout: CONFIG, stderr: Buffer.alloc(0) }
          }
          if (args[0] === 'remote') {
            return { stdout: REMOTE, stderr: Buffer.alloc(0) }
          }
          childHome = options.env.HOME
          expect(childHome).toBeDefined()
          expect(childHome).not.toBe(ambientHome)
          expect(options.env.XDG_CONFIG_HOME).toBe(childHome)
          expect(options.env.NETRC).toBeUndefined()
          expect(existsSync(join(childHome ?? '', '.netrc'))).toBe(false)
          expect(options.terminationBarrier).toBe(true)
          return { stdout: '', stderr: '' }
        }
      )
      await runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        {
          cwd: '/synthetic/a',
          env: {
            ...SYNTHETIC_ENV,
            HOME: ambientHome,
            XDG_CONFIG_HOME: ambientHome,
            NETRC: join(ambientHome, '.netrc')
          }
        },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword: async () => 'synthetic-token'
        }
      )
      expect(childHome).toBeDefined()
      expect(existsSync(childHome ?? '')).toBe(false)
    } finally {
      await rm(ambientHome, { recursive: true, force: true })
    }
  })

  it('refuses unsupported WSL routing before any Git or token read', async () => {
    const identity = boundIdentity()
    const readPassword = vi.fn(async () => 'synthetic-token')
    await expect(
      runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        { cwd: '/synthetic/a', wslDistro: 'Synthetic', env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword
        }
      )
    ).rejects.toThrow('Bound Git operation unavailable.')
    expect(capture).not.toHaveBeenCalled()
    expect(readPassword).not.toHaveBeenCalled()
  })

  it('does not hold admission while a legacy pull owns the worktree lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-bound-git-lock-test-'))
    const repo = join(root, 'repo')
    const controller = new AbortController()
    let releaseLegacy!: () => void
    let legacyReady!: () => void
    const releaseLegacyPromise = new Promise<void>((resolve) => {
      releaseLegacy = resolve
    })
    const legacyReadyPromise = new Promise<void>((resolve) => {
      legacyReady = resolve
    })
    const scheduler = new GitAdmissionScheduler({ networkCap: 1, networkHeadroom: 0 })
    _resetGitAdmissionForTests(scheduler)
    let legacy: Promise<void> | undefined
    let bound: Promise<string> | undefined
    try {
      await mkdir(join(repo, '.git'), { recursive: true })
      legacy = runWithGitWorktreeOperationLock(repo, undefined, async () => {
        legacyReady()
        await releaseLegacyPromise
        return runWithGitFetchHeadLock(repo, undefined, async () => {
          const grant = await acquireGitAdmission({ args: ['pull', 'origin', 'main'], cwd: repo })
          grant.release()
        })
      })
      await legacyReadyPromise
      const identity = {
        ...boundIdentity(),
        operation: 'pull' as const,
        worktreePath: repo,
        commonGitDir: join(repo, '.git')
      }
      capture.mockImplementation(async (_command: string, args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: CONFIG, stderr: Buffer.alloc(0) }
        }
        if (args[0] === 'remote') {
          return { stdout: REMOTE, stderr: Buffer.alloc(0) }
        }
        return { stdout: '', stderr: '' }
      })
      bound = runBoundGitNetworkCommand(
        ['pull', '--ff-only', 'origin', 'main'],
        { cwd: repo, env: SYNTHETIC_ENV, signal: controller.signal },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword: async () => 'synthetic-token'
        }
      ).then(
        () => 'finished',
        () => 'refused'
      )
      await new Promise((resolve) => setTimeout(resolve, 30))
      const heldAdmission = scheduler.snapshot().budgets.network?.baseUsed ?? 0
      releaseLegacy()
      const result = await Promise.race([
        Promise.all([legacy, bound]).then(([, outcome]) => outcome),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500))
      ])
      expect(heldAdmission).toBe(0)
      expect(result).toBe('finished')
    } finally {
      controller.abort()
      releaseLegacy()
      await Promise.allSettled([legacy, bound])
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a URL argument or a missing host record before network', async () => {
    const identity = boundIdentity()
    const readPassword = vi.fn(async () => 'synthetic-token')
    await expect(
      runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'https://elsewhere.invalid/team/b.git', 'HEAD:main'],
        { cwd: '/synthetic/a', env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => identity,
          readPassword
        }
      )
    ).rejects.toThrow('Bound Git operation unavailable.')
    expect(capture).not.toHaveBeenCalled()

    await expect(
      runBoundGitNetworkCommand(
        ['push', '--set-upstream', 'origin', 'HEAD:main'],
        { cwd: '/synthetic/a', env: SYNTHETIC_ENV },
        {
          identity,
          launcherPath: process.execPath,
          readCurrentIdentity: async () => null,
          readPassword
        }
      )
    ).rejects.toThrow('Bound Git operation unavailable.')
    expect(capture).not.toHaveBeenCalled()
    expect(readPassword).not.toHaveBeenCalled()
  })
})
