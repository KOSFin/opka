import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { preparePtyAccountPoolLaunch } from './account-pool-launch'
const hooks = vi.hoisted(() => ({
  policy: vi.fn(() => ({
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'sequential',
    members: [{ accountId: 'a', state: 'enabled' }]
  })),
  claude: vi.fn(async () => ({ envPatch: { CLAUDE_CONFIG_DIR: '/synthetic/exact' } }))
}))
vi.mock('../../runtime/runtime-account-pool-policy', () => ({
  getDefaultAccountPool: hooks.policy
}))
vi.mock('../../runtime/account-pool-candidates', () => ({ accountPoolCandidates: () => [] }))
vi.mock('../../claude-accounts/pinned-account-launch', () => ({
  preparePinnedClaudeAccountLaunch: hooks.claude
}))
function fixture() {
  const acquire = vi.fn((args: { ownerKey: string }) => ({ ...args, accountId: 'a' }))
  const release = vi.fn()
  const subscribe = vi.fn((_id: string, _listener: () => void) => vi.fn())
  const host = {
    getOrchestrationDb: () => ({
      acquireAccountPoolAssignment: acquire,
      releaseAccountPoolAssignment: release,
      bindAccountPoolAssignmentPty: vi.fn()
    }),
    getAccountsSnapshot: () => ({}),
    getPtyExecutionHostMetadata: vi.fn(() => ({ incarnationId: 'original' })),
    requireStore: () => ({ getSettings: () => ({ claudeManagedAccounts: [] }) }),
    getWorkerCodexAccountEnv: vi.fn(() => ({ ORCA_WORKER_CODEX_ACCOUNT_ID: 'a' })),
    subscribeToPtyExit: subscribe
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: synthetic host implements every method this isolated launch helper accesses.
  const runtime = host as unknown as OrcaRuntimeService
  return { host, runtime, acquire, release, subscribe }
}
it('pins a fresh managed launch and retains its lease until an owning-host exit', async () => {
  const f = fixture()
  const launch = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'codex',
    adopted: false,
    resume: false,
    wsl: false
  })
  expect(await launch?.prepareEnv()).toEqual({ ORCA_WORKER_CODEX_ACCOUNT_ID: 'a' })
  launch?.bind('pty', false, false)
  expect(f.release).not.toHaveBeenCalled()
  f.subscribe.mock.calls[0][1]()
  expect(f.release).toHaveBeenCalledOnce()
  launch?.release()
  expect(f.release).toHaveBeenCalledOnce()
})
it.each([
  { adopted: true },
  { resume: true },
  { wsl: true },
  { connectionId: 'remote' },
  { env: { ORCA_WORKER_CODEX_ACCOUNT_ID: 'worker-fixed' } }
])('does not enroll incompatible or already owned execution %j', (override) => {
  const f = fixture()
  expect(
    preparePtyAccountPoolLaunch({
      runtime: f.runtime,
      agent: 'codex',
      adopted: false,
      resume: false,
      wsl: false,
      ...override
    })
  ).toBeUndefined()
  expect(f.acquire).not.toHaveBeenCalled()
})
it('uses pinned Claude preparation and releases an unstarted or adopted lease', async () => {
  const f = fixture()
  const launch = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'claude',
    adopted: false,
    resume: false,
    wsl: false
  })
  expect(await launch?.prepareEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/synthetic/exact' })
  launch?.bind('existing', false, true)
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.subscribe).not.toHaveBeenCalled()
})

it('revalidates policy generation before allowing a spawn', async () => {
  const f = fixture()
  const launch = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'codex',
    adopted: false,
    resume: false,
    wsl: false
  })
  await expect(launch?.assertReady()).resolves.toBeUndefined()
  hooks.policy.mockReturnValueOnce({
    id: 'pool',
    provider: 'codex',
    revision: 2,
    strategy: 'sequential',
    members: [{ accountId: 'a', state: 'enabled' }]
  })
  await expect(launch?.assertReady()).rejects.toThrow(/changed during launch/)
  expect(f.release).not.toHaveBeenCalled()
  launch?.release()
})
it('strips inherited Claude credentials and asks the spawn provider to remove host credentials', async () => {
  const f = fixture()
  const launch = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'claude',
    adopted: false,
    resume: false,
    wsl: false,
    env: {
      ANTHROPIC_API_KEY: 'synthetic',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: synthetic',
      KEEP: 'yes'
    }
  })
  expect(await launch?.prepareEnv()).toEqual({ KEEP: 'yes', CLAUDE_CONFIG_DIR: '/synthetic/exact' })
  expect(launch?.envToDelete).toContain('ANTHROPIC_API_KEY')
  expect(launch?.envToDelete).toContain('ANTHROPIC_CUSTOM_HEADERS')
  launch?.release()
})

it('rechecks policy after awaited Claude preparation', async () => {
  const f = fixture()
  const launch = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'claude',
    adopted: false,
    resume: false,
    wsl: false
  })
  hooks.claude.mockImplementationOnce(async () => {
    hooks.policy.mockReturnValueOnce({
      id: 'pool',
      provider: 'codex',
      revision: 2,
      strategy: 'sequential',
      members: [{ accountId: 'a', state: 'disabled' }]
    })
    return { envPatch: { CLAUDE_CONFIG_DIR: '/synthetic/exact' } }
  })
  await expect(launch?.assertReady()).rejects.toThrow(/changed during launch/)
  launch?.release()
})
it('retains the lease if an exit callback belongs to a reused or unverifiable PTY generation', () => {
  const f = fixture()
  const launch = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'codex',
    adopted: false,
    resume: false,
    wsl: false
  })
  launch?.bind('pty', false, false, 'original')
  f.host.getPtyExecutionHostMetadata.mockReturnValue({ incarnationId: 'successor' })
  f.subscribe.mock.calls[0][1]()
  expect(f.release).not.toHaveBeenCalled()
})

it('keeps the native selected-account path for an automatically applied manual pool', () => {
  const f = fixture()
  hooks.policy.mockReturnValueOnce({
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'manual',
    members: [{ accountId: 'a', state: 'enabled' }]
  })
  expect(
    preparePtyAccountPoolLaunch({
      runtime: f.runtime,
      agent: 'codex',
      adopted: false,
      resume: false,
      wsl: false
    })
  ).toBeUndefined()
  expect(f.acquire).not.toHaveBeenCalled()
})
