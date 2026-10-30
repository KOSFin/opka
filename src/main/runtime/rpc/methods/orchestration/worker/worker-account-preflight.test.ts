import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import { prepareWorkerAccountEnv } from './worker-account-preflight'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'

vi.mock('../../../../../claude-accounts/pinned-account-launch', () => ({
  preparePinnedClaudeAccountLaunch: vi.fn(async () => ({ envPatch: {} }))
}))

const terminal: WorkerStartModeReceipt = {
  mode: 'terminal',
  preferred: 'terminal',
  reason: 'user_default',
  detail: ''
}
function fixture(executionHostId = 'local', path = '/synthetic/folder') {
  const runtime = {
    listRepos: vi.fn(() => []),
    showRepo: vi.fn(async () => ({
      id: 'remote-repo',
      path: '/synthetic/remote',
      executionHostId: 'ssh:foreign'
    })),
    resolveRuntimeFileTarget: vi.fn(async () => ({ executionHostId, worktree: { path } })),
    getWorkerCodexAccountEnv: vi.fn(() => ({ CODEX_HOME: '/synthetic/account/home' }))
  }
  return {
    runtime,
    prepare: (overrides = {}, mode = terminal) =>
      prepareWorkerAccountEnv(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight only uses the three read-only methods implemented here.
        runtime as unknown as OrcaRuntimeService,
        WorkerStartParams.parse({
          task: 'task',
          from: 'term',
          agent: 'codex',
          accountId: 'opaque-account',
          ...overrides
        }),
        mode,
        { id: 'folder-workspace', repoId: 'folder' }
      )
  }
}
describe('worker account preflight before dispatch effects', () => {
  it('supports native folder workspaces and resolves identity at the owning host', async () => {
    const f = fixture()
    await expect(f.prepare()).resolves.toEqual({ CODEX_HOME: '/synthetic/account/home' })
    expect(f.runtime.resolveRuntimeFileTarget).toHaveBeenCalledWith('id:folder-workspace')
    expect(f.runtime.getWorkerCodexAccountEnv).toHaveBeenCalledWith('opaque-account')
  })
  it('does not resolve or alter account defaults for ordinary launches', async () => {
    const f = fixture()
    await expect(f.prepare({ accountId: undefined })).resolves.toBeUndefined()
    expect(f.runtime.resolveRuntimeFileTarget).not.toHaveBeenCalled()
    expect(f.runtime.getWorkerCodexAccountEnv).not.toHaveBeenCalled()
  })
  it.each([{ agent: 'gemini' }, { terminal: 'existing' }, { on: 'remote' }])(
    'rejects unsupported adapter or placement %j',
    async (overrides) => {
      const f = fixture()
      await expect(f.prepare(overrides)).rejects.toThrow('new local host Claude or Codex terminal')
      expect(f.runtime.getWorkerCodexAccountEnv).not.toHaveBeenCalled()
    }
  )
  it('resolves explicit repository selectors before accepting their host', async () => {
    const f = fixture()
    await expect(f.prepare({ repo: 'id:remote-repo' })).rejects.toThrow(
      'new local host Claude or Codex terminal'
    )
    expect(f.runtime.showRepo).toHaveBeenCalledWith('id:remote-repo')
    expect(f.runtime.getWorkerCodexAccountEnv).not.toHaveBeenCalled()
  })

  it('rejects structured mode before resolving account data', async () => {
    const f = fixture()
    await expect(f.prepare({}, { ...terminal, mode: 'structured' })).rejects.toThrow(
      'new local host Claude or Codex terminal'
    )
    expect(f.runtime.getWorkerCodexAccountEnv).not.toHaveBeenCalled()
  })
  it.each(['ssh:new-server', 'runtime:foreign'])('refuses foreign owning host %s', async (host) => {
    const f = fixture(host)
    await expect(f.prepare()).rejects.toThrow('local host workspace')
    expect(f.runtime.getWorkerCodexAccountEnv).not.toHaveBeenCalled()
  })
})

it('prepares a pinned Claude account without changing the selected account', async () => {
  const f = fixture()
  await expect(f.prepare({ agent: 'claude' })).resolves.toEqual({
    ORCA_WORKER_CLAUDE_ACCOUNT_ID: 'opaque-account'
  })
  expect(f.runtime.getWorkerCodexAccountEnv).not.toHaveBeenCalled()
})
