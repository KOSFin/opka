import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as ClaudeOAuthCredentials from './claude-oauth-credentials'

type CredentialSourceFixture = {
  source: ClaudeOAuthCredentials.ClaudeOAuthCredentialSource
  readCredentials: ReturnType<typeof vi.fn>
  fetchUsage: ReturnType<typeof vi.fn>
  hostPreparation: ReturnType<typeof vi.fn>
  wslPreparation: ReturnType<typeof vi.fn>
}

const fixture = vi.hoisted((): CredentialSourceFixture => ({
  source: 'credentials-file',
  readCredentials: vi.fn(),
  fetchUsage: vi.fn(),
  hostPreparation: vi.fn(),
  wslPreparation: vi.fn()
}))

vi.mock('./claude-oauth-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeOAuthCredentials>()),
  readClaudeOAuthCredentials: fixture.readCredentials
}))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({ accountUsagePreparation: fixture.hostPreparation }),
  getClaudeWslProfileRouter: () => ({ accountUsagePreparation: fixture.wslPreparation })
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: async (paths: readonly string[]) => [...paths]
}))
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: fixture.fetchUsage }))

import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'
import { OAuthUsageError } from './claude-oauth-usage-error'

const configDir = join(tmpdir(), 'synthetic-claude-profile-A')
const now = 1800000000000

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  fixture.readCredentials.mockImplementation(async () => ({
    token: 'synthetic-token',
    hasRefreshableCredentials: false,
    source: fixture.source
  }))
  fixture.fetchUsage.mockRejectedValue(new OAuthUsageError('Synthetic wait', 429, true, 3600000))
})

afterEach(() => vi.restoreAllMocks())

it.each(['host', 'wsl'] as const)(
  'retains %s account identity on successful quota reads',
  async (runtime) => {
    const provenance = runtime === 'wsl' ? 'wsl:SyntheticDistro:profile:A' : 'profile:A'
    const preparation = { configDir, envPatch: { CLAUDE_CONFIG_DIR: configDir }, provenance }
    fixture.hostPreparation.mockReturnValue(preparation)
    fixture.wslPreparation.mockResolvedValue(preparation)
    fixture.fetchUsage.mockResolvedValue({
      provider: 'claude',
      status: 'ok',
      error: null,
      updatedAt: now,
      session: { usedPercent: 21 },
      weekly: null,
      usageMetadata: { source: 'oauth' }
    })
    const result = await fetchInactiveClaudeAccountUsage({
      id: 'A',
      managedAuthRuntime: runtime,
      wslDistro: runtime === 'wsl' ? 'SyntheticDistro' : null
    })
    expect(result).toMatchObject({
      status: 'ok',
      session: { usedPercent: 21 },
      usageMetadata: {
        source: 'oauth',
        authProvenance: provenance,
        credentialSource: fixture.source
      }
    })
  }
)

it.each([
  ['host', 'scoped-keychain'],
  ['host', 'credentials-file'],
  ['wsl', 'credentials-file']
] as const)('keeps %s profile 429 metadata from %s', async (runtime, source) => {
  fixture.source = source
  const provenance = runtime === 'wsl' ? 'wsl:SyntheticDistro:profile:A' : 'profile:A'
  const preparation = {
    configDir,
    envPatch: { CLAUDE_CONFIG_DIR: configDir },
    provenance
  }
  fixture.hostPreparation.mockReturnValue(preparation)
  fixture.wslPreparation.mockResolvedValue(preparation)
  const result = await fetchInactiveClaudeAccountUsage({
    id: 'A',
    managedAuthRuntime: runtime,
    wslDistro: runtime === 'wsl' ? 'SyntheticDistro' : null
  })

  expect(result.usageMetadata).toMatchObject({
    credentialSource: source,
    authProvenance: provenance,
    failureKind: 'rate-limited',
    retryAtMs: now + 3600000
  })
  expect(fixture.readCredentials).toHaveBeenCalledWith({
    credentialsFileConfigDir: configDir,
    keychainConfigDir: configDir,
    unsuffixedKeychainFallback: false
  })
  expect(fixture.fetchUsage).toHaveBeenCalledWith('synthetic-token', undefined)
  if (runtime === 'wsl') {
    expect(fixture.wslPreparation).toHaveBeenCalledWith('SyntheticDistro', 'A')
    expect(fixture.hostPreparation).not.toHaveBeenCalled()
  } else {
    expect(fixture.hostPreparation).toHaveBeenCalledWith('A')
    expect(fixture.wslPreparation).not.toHaveBeenCalled()
  }
})

it('refreshes a dedicated inactive source before the read-only quota request, retaining its identity', async () => {
  const signal = new AbortController().signal
  const prepareAuth = vi.fn(async () => ({
    configDir,
    envPatch: { CLAUDE_CONFIG_DIR: configDir },
    provenance: 'profile:A'
  }))
  const result = await fetchInactiveClaudeAccountUsage({ id: 'A', prepareAuth }, { signal })
  expect(prepareAuth).toHaveBeenCalledWith(signal)
  expect(fixture.hostPreparation).not.toHaveBeenCalled()
  expect(fixture.fetchUsage).toHaveBeenCalledWith('synthetic-token', signal)
  expect(result.usageMetadata?.authProvenance).toBe('profile:A')
})

it('keeps an unavailable dedicated source from borrowing legacy credentials or making a quota request', async () => {
  const result = await fetchInactiveClaudeAccountUsage({
    id: 'A',
    prepareAuth: async () => ({
      configDir: '',
      envPatch: {},
      provenance: 'profile:A',
      usageError: 'Reconnect this source.'
    })
  })
  expect(result.status).toBe('error')
  expect(fixture.hostPreparation).not.toHaveBeenCalled()
  expect(fixture.readCredentials).not.toHaveBeenCalled()
  expect(fixture.fetchUsage).not.toHaveBeenCalled()
})
