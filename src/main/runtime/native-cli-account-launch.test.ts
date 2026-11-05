import { beforeEach, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  prepareNativeCliAccountLaunch,
  releaseNativeCliAccountLaunch
} from './native-cli-account-launch'

const hooks = vi.hoisted(() => ({ pinned: vi.fn(), candidates: vi.fn(), claudeRouting: vi.fn() }))
vi.mock('../claude-accounts/pinned-account-launch', () => ({
  preparePinnedClaudeAccountLaunch: hooks.pinned
}))
vi.mock('./native-claude-routing-launch', () => ({
  prepareNativeClaudeRoutingLaunch: hooks.claudeRouting
}))
vi.mock('./account-pool-candidates', () => ({ accountPoolCandidates: hooks.candidates }))
vi.mock('./native-codex-routing-launch', () => ({
  prepareNativeCodexRoutingLaunch: async () => null
}))
beforeEach(() => {
  vi.resetAllMocks()
  hooks.claudeRouting.mockResolvedValue(null)
  hooks.candidates.mockReturnValue([
    { provider: 'claude', accountId: 'a', quotaIdentity: 'a', auth: 'ready', quota: 'unknown' },
    { provider: 'codex', accountId: 'a', quotaIdentity: 'a', auth: 'ready', quota: 'unknown' }
  ])
  hooks.pinned.mockResolvedValue({ envPatch: { CLAUDE_CONFIG_DIR: '/profiles/a' } })
})
function fixture(provider: 'claude' | 'codex') {
  const settings = createGlobalSettingsFixture()
  settings.accountPools = [
    {
      id: 'pool',
      provider,
      revision: 2,
      strategy: 'balanced',
      applyToNewWork: true,
      rotation: 'after-turn',
      unknownQuota: 'allow',
      allowReserve: false,
      members: [{ accountId: 'a', priority: 1, weight: 1, state: 'enabled', role: 'primary' }]
    }
  ]
  const db = {
    acquireAccountPoolAssignment: vi.fn(({ ownerKey }) => ({ ownerKey, accountId: 'a' })),
    releaseAccountPoolAssignment: vi.fn()
  }
  const manual = {
    prepareForCodexLaunch: vi.fn(async () => '/profiles/manual-codex'),
    prepareForClaudeLaunch: vi.fn(async () => ({
      provenance: 'profile:manual-claude',
      envPatch: { CLAUDE_CONFIG_DIR: '/profiles/manual-claude' }
    }))
  }
  const host = {
    requireStore: () => ({ getSettings: () => settings }),
    getAccountsSnapshot: () => ({}),
    getOrchestrationDb: () => db,
    getWorkerCodexAccountEnv: vi.fn(() => ({ CODEX_HOME: '/profiles/a' })),
    getCommitMessageAgentEnvironmentResolvers: () => manual
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the declared account preparation surface is exercised; all dependencies are synthetic.
  const runtime = host as unknown as OrcaRuntimeService
  return { settings, db, host, manual, runtime }
}
const launchId = '12345678-1234-4234-8234-123456789012'
it.each(['claude', 'codex'] as const)(
  'uses the enabled %s pool without consulting the manual default',
  async (provider) => {
    const f = fixture(provider)
    const plan = await prepareNativeCliAccountLaunch(f.runtime, { provider, launchId })
    expect(plan).toMatchObject({ launchId, accountId: 'a', poolId: 'pool', policyRevision: 2 })
    expect(f.db.acquireAccountPoolAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKey: `native-cli:${launchId}`,
        candidates: [expect.objectContaining({ provider })]
      })
    )
    expect(f.manual.prepareForClaudeLaunch).not.toHaveBeenCalled()
    expect(f.manual.prepareForCodexLaunch).not.toHaveBeenCalled()
    expect(plan.envToDelete).toContain('ORCA_NATIVE_CLI_ACCOUNT_PIN')
  }
)
it.each(['claude', 'codex'] as const)(
  'uses the native %s manual default when the pool is disabled',
  async (provider) => {
    const f = fixture(provider)
    f.settings.accountPools![0]!.applyToNewWork = false
    const plan = await prepareNativeCliAccountLaunch(f.runtime, { provider, launchId })
    expect(plan.poolId).toBeNull()
    expect(plan.env).toEqual(
      provider === 'claude'
        ? { CLAUDE_CONFIG_DIR: '/profiles/manual-claude' }
        : { CODEX_HOME: '/profiles/manual-codex' }
    )
    expect(f.db.acquireAccountPoolAssignment).not.toHaveBeenCalled()
    if (provider === 'claude') {
      expect(plan.envToDelete).toContain('ANTHROPIC_API_KEY')
    }
  }
)
it('keeps an explicit managed launch pin without acquiring a second lease', async () => {
  const f = fixture('claude')
  await prepareNativeCliAccountLaunch(f.runtime, { provider: 'claude', launchId, accountId: 'a' })
  expect(f.db.acquireAccountPoolAssignment).not.toHaveBeenCalled()
  expect(hooks.pinned).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a' }))
})
it('fails closed when the pool has no eligible member', async () => {
  const f = fixture('codex')
  f.db.acquireAccountPoolAssignment.mockImplementation(() => {
    throw new Error('No eligible account')
  })
  await expect(
    prepareNativeCliAccountLaunch(f.runtime, { provider: 'codex', launchId })
  ).rejects.toThrow('No eligible')
  expect(f.manual.prepareForCodexLaunch).not.toHaveBeenCalled()
})
it('releases only its new reservation when policy changes during native profile preparation', async () => {
  const f = fixture('claude')
  hooks.pinned.mockImplementation(async () => {
    f.settings.accountPools![0]!.revision++
    return { envPatch: { CLAUDE_CONFIG_DIR: '/profiles/a' } }
  })
  await expect(
    prepareNativeCliAccountLaunch(f.runtime, { provider: 'claude', launchId })
  ).rejects.toThrow('pool changed')
  expect(f.db.releaseAccountPoolAssignment).toHaveBeenCalledExactlyOnceWith(
    `native-cli:${launchId}`
  )
})
it('releases only the owning native CLI reservation after observed child exit', async () => {
  const f = fixture('claude')
  await releaseNativeCliAccountLaunch(f.runtime, launchId)
  expect(f.db.releaseAccountPoolAssignment).toHaveBeenCalledExactlyOnceWith(
    `native-cli:${launchId}`
  )
})
it.each(['claude', 'codex'] as const)(
  'classifies external interactive %s before acquiring any assignment',
  async (provider) => {
    const f = fixture(provider)
    const plan = await prepareNativeCliAccountLaunch(f.runtime, {
      provider,
      launchId,
      interactive: true
    })
    expect(plan).toMatchObject({
      executionMode: 'host-pty',
      poolId: null,
      accountId: null,
      env: {}
    })
    expect(f.db.acquireAccountPoolAssignment).not.toHaveBeenCalled()
    expect(hooks.pinned).not.toHaveBeenCalled()
    expect(f.manual.prepareForCodexLaunch).not.toHaveBeenCalled()
  }
)
