import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { REPO_GIT_AUTHOR_METHODS } from '../runtime/rpc/methods/repo-git-author-methods'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  runtimeRepoSelectorHostId,
  runtimeRepoSelectorText,
  type RuntimeRepoSelector
} from '../runtime/runtime-repo-selector'
import { gitExecFileAsync } from './runner'
import { readRepoGitAuthor, updateRepoGitAuthor } from './repo-git-author'

describe('repository Git commit author', () => {
  let root: string
  let previousGlobal: string | undefined
  let previousNoSystem: string | undefined
  let globalPath: string

  async function git(cwd: string, ...args: string[]): Promise<string> {
    return (await gitExecFileAsync(args, { cwd, timeout: 5000 })).stdout.trim()
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-git-author-'))
    previousGlobal = process.env.GIT_CONFIG_GLOBAL
    previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM
    globalPath = join(root, 'global.gitconfig')
    process.env.GIT_CONFIG_GLOBAL = globalPath
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    await writeFile(globalPath, '[user]\n\tname = Global Person\n\temail = global@example.test\n')
  })

  afterEach(async () => {
    if (previousGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal
    }
    if (previousNoSystem === undefined) {
      delete process.env.GIT_CONFIG_NOSYSTEM
    } else {
      process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem
    }
    await rm(root, { recursive: true, force: true })
  })

  it('keeps two repo authors and a linked worktree separate from global and neighboring config', async () => {
    const aPath = join(root, 'a')
    const bPath = join(root, 'b')
    const linkedPath = join(root, 'a-linked')
    await mkdir(aPath)
    await mkdir(bPath)
    await git(aPath, 'init', '--quiet')
    await git(bPath, 'init', '--quiet')
    const a = { id: 'a', path: aPath, kind: 'git' as const }
    const b = { id: 'b', path: bPath, kind: 'git' as const }
    const globalBefore = await readFile(globalPath, 'utf8')
    const initial = await readRepoGitAuthor(a)
    expect(initial.name).toMatchObject({
      effective: 'Global Person',
      local: null,
      origin: 'inherited'
    })
    await updateRepoGitAuthor(a, {
      name: 'Alice Author',
      email: 'alice@example.test',
      expectedLocalName: null,
      expectedLocalEmail: null
    })
    const aConfigBeforeB = await readFile(join(aPath, '.git', 'config'), 'utf8')
    await updateRepoGitAuthor(b, {
      name: 'Bob Author',
      email: 'bob@example.test',
      expectedLocalName: null,
      expectedLocalEmail: null
    })
    expect((await readRepoGitAuthor(a)).name.effective).toBe('Alice Author')
    expect((await readRepoGitAuthor(b)).name.effective).toBe('Bob Author')
    expect(await readFile(join(aPath, '.git', 'config'), 'utf8')).toBe(aConfigBeforeB)
    await git(aPath, 'commit', '--allow-empty', '--quiet', '-m', 'fixture')
    await git(aPath, 'worktree', 'add', '--quiet', '--detach', linkedPath)
    const linked = { id: 'a-linked', path: linkedPath, kind: 'git' as const }
    expect((await readRepoGitAuthor(linked)).name.local).toBe('Alice Author')
    await updateRepoGitAuthor(linked, {
      name: 'Linked Author',
      email: 'linked@example.test',
      expectedLocalName: 'Alice Author',
      expectedLocalEmail: 'alice@example.test'
    })
    expect((await readRepoGitAuthor(a)).name.local).toBe('Linked Author')
    expect((await readRepoGitAuthor(b)).name.local).toBe('Bob Author')
    expect(await readFile(globalPath, 'utf8')).toBe(globalBefore)
  })

  it('rejects stale edits and restores inherited fields without touching a neighbor', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    await git(repoPath, 'init', '--quiet')
    const repo = { id: 'repo', path: repoPath, kind: 'git' as const }
    await updateRepoGitAuthor(repo, {
      name: 'Local',
      email: 'local@example.test',
      expectedLocalName: null,
      expectedLocalEmail: null
    })
    await expect(
      updateRepoGitAuthor(repo, {
        name: 'Wrong',
        email: 'wrong@example.test',
        expectedLocalName: null,
        expectedLocalEmail: null
      })
    ).rejects.toThrow('changed on this host')
    await updateRepoGitAuthor(repo, {
      name: null,
      email: null,
      expectedLocalName: 'Local',
      expectedLocalEmail: 'local@example.test'
    })
    expect((await readRepoGitAuthor(repo)).email).toMatchObject({
      effective: 'global@example.test',
      local: null,
      origin: 'inherited'
    })
    await expect(
      updateRepoGitAuthor(repo, {
        name: 'Bad\nName',
        email: null,
        expectedLocalName: null,
        expectedLocalEmail: null
      })
    ).rejects.toThrow('one line')
  })

  it('keeps RPC author writes local to the selected host and independent of two network profiles', async () => {
    const aPath = join(root, 'a')
    const bPath = join(root, 'b')
    await mkdir(aPath)
    await mkdir(bPath)
    await git(aPath, 'init', '--quiet')
    await git(bPath, 'init', '--quiet')
    const a: Repo = {
      id: 'a',
      path: aPath,
      kind: 'git',
      displayName: 'a',
      badgeColor: '',
      addedAt: 1,
      gitNetworkBinding: {
        provider: 'gitlab',
        id: 'a'.repeat(64),
        host: 'gitlab.com',
        user: 'alice',
        generation: '00000000-0000-4000-8000-000000000001'
      }
    }
    const b: Repo = {
      id: 'b',
      path: bPath,
      kind: 'git',
      displayName: 'b',
      badgeColor: '',
      addedAt: 2,
      gitNetworkBinding: {
        provider: 'github',
        host: 'github.com',
        user: 'bob',
        generation: '00000000-0000-4000-8000-000000000002'
      }
    }
    const rows = new Map([
      ['a', a],
      ['b', b]
    ])
    const showRepo = vi.fn(async (selector: RuntimeRepoSelector): Promise<Repo> => {
      const row = rows.get(runtimeRepoSelectorText(selector).replace(/^id:/, ''))
      if (
        !row ||
        (runtimeRepoSelectorHostId(selector) &&
          runtimeRepoSelectorHostId(selector) !== getRepoExecutionHostId(row))
      ) {
        throw new Error('Repository unavailable on selected host')
      }
      return row
    })
    const runtime = { getRuntimeId: () => 'test-runtime', showRepo }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These cases dispatch only the two author methods and supply their runtime dependencies.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: REPO_GIT_AUTHOR_METHODS
    })
    const request = (id: string, expectedPath: string, name: string, email: string) => ({
      id: `update-${id}`,
      authToken: 'synthetic',
      method: 'repo.gitAuthor.update',
      params: {
        repo: `id:${id}`,
        repoHostId: 'local',
        expectedPath,
        name,
        email,
        expectedLocalName: null,
        expectedLocalEmail: null
      }
    })
    const globalBefore = await readFile(globalPath, 'utf8')
    expect((await dispatcher.dispatch(request('a', aPath, 'Author A', 'a@example.test'))).ok).toBe(
      true
    )
    expect((await dispatcher.dispatch(request('b', bPath, 'Author B', 'b@example.test'))).ok).toBe(
      true
    )
    expect((await readRepoGitAuthor(a)).name.local).toBe('Author A')
    expect((await readRepoGitAuthor(b)).name.local).toBe('Author B')
    expect(a.gitNetworkBinding?.user).toBe('alice')
    expect(b.gitNetworkBinding?.user).toBe('bob')
    expect(await readFile(globalPath, 'utf8')).toBe(globalBefore)

    const wrongPath = request('a', bPath, 'Wrong', 'wrong@example.test')
    expect((await dispatcher.dispatch(wrongPath)).ok).toBe(false)
    const wrongHost = request('a', aPath, 'Wrong', 'wrong@example.test')
    expect(
      (
        await dispatcher.dispatch({
          ...wrongHost,
          params: { ...wrongHost.params, repoHostId: 'ssh:other' }
        })
      ).ok
    ).toBe(false)
    expect(showRepo).toHaveBeenLastCalledWith({ selector: 'id:a', hostId: 'ssh:other' })
    expect((await readRepoGitAuthor(a)).name.local).toBe('Author A')
    expect((await readRepoGitAuthor(b)).name.local).toBe('Author B')
  })

  it('refuses folder and non-root paths', async () => {
    const repoPath = join(root, 'repo')
    const nestedPath = join(repoPath, 'nested')
    await mkdir(repoPath)
    await git(repoPath, 'init', '--quiet')
    await mkdir(nestedPath)
    await expect(
      readRepoGitAuthor({ id: 'folder', path: repoPath, kind: 'folder' })
    ).rejects.toThrow('folder')
    await expect(
      readRepoGitAuthor({ id: 'nested', path: nestedPath, kind: 'git' })
    ).rejects.toThrow('root')
  })

  it.skipIf(process.platform !== 'win32')('refuses a WSL path before local Git runs', async () => {
    await expect(
      readRepoGitAuthor({
        id: 'wsl',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\fixture',
        kind: 'git'
      })
    ).rejects.toThrow('WSL-owned')
  })
})
