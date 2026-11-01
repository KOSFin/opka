import { fetchClaudeRateLimits } from './claude-fetcher'
import { beforeEach, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchCodexRateLimits, consumeCodexRateLimitResetCredit } from './codex-fetcher'
import {
  deferred,
  okProvider,
  unavailableProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'
vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-source-selection', () => ({
  fetchOpenCodeGoUsage: vi.fn()
}))

vi.mock('./zcode-usage-fetcher', () => ({
  fetchZcodeRateLimits: vi.fn()
}))

vi.mock('./antigravity-usage-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

beforeEach(() => {
  resetRateLimitProviderMocks()
  vi.mocked(fetchClaudeRateLimits).mockReset().mockResolvedValue(unavailableProvider('claude'))
  vi.mocked(fetchCodexRateLimits).mockReset()
})
it.each(['single', 'full'] as const)(
  'tags the captured Codex source without exposing private paths in a %s cycle',
  async (mode) => {
    const service = new RateLimitService()
    service.setCodexHomePathResolver(() => ({
      kind: 'ready',
      codexHomePath: '/private/synthetic/home',
      authProvenance: 'profile:a'
    }))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20, Date.now()))
    await (mode === 'single'
      ? service.refreshCodexForTarget({ runtime: 'host' })
      : service.refresh())
    expect(service.getState().codex?.usageMetadata?.authProvenance).toBe('profile:a')
    expect(JSON.stringify(service.getState())).not.toContain('/private/synthetic/home')
  }
)
it.each(['single', 'full'] as const)(
  'rejects the old result when source changes on the same home during a %s cycle',
  async (mode) => {
    const service = new RateLimitService()
    let source = 'profile:a'
    service.setCodexHomePathResolver(() => ({
      kind: 'ready',
      codexHomePath: '/synthetic/shared',
      authProvenance: source
    }))
    const result = deferred<ReturnType<typeof okProvider>>()
    vi.mocked(fetchCodexRateLimits).mockReturnValueOnce(result.promise)
    const pending =
      mode === 'single' ? service.refreshCodexForTarget({ runtime: 'host' }) : service.refresh()
    await vi.waitFor(() => expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1))
    source = 'profile:b'
    result.resolve(okProvider('codex', 99, Date.now()))
    await pending
    expect(service.getState().codex?.session?.usedPercent).not.toBe(99)
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 12, Date.now()))
    await service.refreshCodexForTarget({ runtime: 'host' })
    expect(service.getState().codex).toMatchObject({
      usageMetadata: { authProvenance: 'profile:b' },
      session: { usedPercent: 12 }
    })
  }
)
it('never relabels previous profile data as a new profile on a failed refresh', async () => {
  const service = new RateLimitService()
  let source = 'profile:a'
  service.setCodexHomePathResolver(() => ({
    kind: 'ready',
    codexHomePath: '/synthetic/shared',
    authProvenance: source
  }))
  vi.mocked(fetchCodexRateLimits)
    .mockResolvedValueOnce(okProvider('codex', 91, Date.now()))
    .mockRejectedValueOnce(new Error('offline'))
  await service.refreshCodexForTarget({ runtime: 'host' })
  source = 'profile:b'
  await service.refreshCodexForTarget({ runtime: 'host' })
  expect(service.getState().codex).toMatchObject({
    session: null,
    usageMetadata: { authProvenance: 'profile:b' }
  })
})
it('tags reset results by the source captured before redemption, not a later default', async () => {
  const service = new RateLimitService()
  let source = 'profile:a'
  service.setCodexHomePathResolver(() => ({
    kind: 'ready',
    codexHomePath: '/synthetic/shared',
    authProvenance: source
  }))
  vi.mocked(consumeCodexRateLimitResetCredit).mockImplementation(async () => {
    source = 'profile:b'
    return 'reset'
  })
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 0, Date.now()))
  const result = await service.consumeCodexRateLimitResetCredit({
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
    target: { runtime: 'host', wslDistro: null },
    codexHomePath: '/synthetic/shared'
  })
  expect(result.state.codex?.usageMetadata?.authProvenance).toBe('profile:a')
  expect(service.getState().codex?.usageMetadata?.authProvenance).not.toBe('profile:b')
})

it('never seeds outgoing managed account caches from a different proven profile', async () => {
  const service = new RateLimitService()
  service.setCodexHomePathResolver(() => ({
    kind: 'ready',
    codexHomePath: '/synthetic/shared',
    authProvenance: 'profile:a'
  }))
  service.setInactiveCodexAccountsResolver(() => [
    { id: 'b', resolveHome: () => ({ kind: 'ready', managedHomePath: '/synthetic/b' }) }
  ])
  service.setInactiveClaudeAccountsResolver(() => [{ id: 'b' }])
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 91, Date.now()))
  vi.mocked(fetchClaudeRateLimits).mockResolvedValue({
    ...okProvider('claude', 91, Date.now()),
    usageMetadata: { authProvenance: 'profile:a' }
  })
  await service.refresh()
  await service.refreshForCodexAccountChange('b')
  await service.refreshForClaudeAccountChange('b')
  expect(
    service.getState().inactiveCodexAccounts.find((entry) => entry.accountId === 'b')?.rateLimits
  ).toBeUndefined()
  expect(
    service.getState().inactiveClaudeAccounts.find((entry) => entry.accountId === 'b')?.rateLimits
  ).toBeUndefined()
})
