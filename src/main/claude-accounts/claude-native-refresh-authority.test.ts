import { beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeNativeAccessSnapshot } from './claude-native-access'
import type { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { ClaudeNativeRefreshSource } from './claude-native-refresh-authority'
import { parseClaudeOAuthCredentialsJson } from '../rate-limits/claude-oauth-credentials'

const identity = {
  accountUuid: 'fake-account',
  organizationUuid: 'fake-org',
  emailAddress: 'fake@example.invalid'
}
const snapshot = (expiresAt: number): ClaudeNativeAccessSnapshot => ({
  access: { accessToken: 'fake-access', expiresAt, scopes: ['user:inference'] },
  identity
})
const source = (name = 'one'): ClaudeNativeRefreshSource => ({
  configDir: `/fake/${name}`,
  nativeUserHome: '/fake/native-user',
  writerDirectory: `/fake/${name}/writer`,
  expectedIdentity: identity,
  launch: { command: '/fake/claude', args: [] },
  qualifiedVersion: '2.1.318',
  assertExclusive: vi.fn()
})
const runner = (impl: typeof runAgentModelCatalogListing) => vi.fn(impl)
const reserve = () => ({ recordGroup: vi.fn(), release: vi.fn(), cancelBeforeSpawn: vi.fn() })
beforeEach(() => vi.resetModules())

it('projects native nullable subscription fields without carrying the refresh token', () => {
  const result = parseClaudeOAuthCredentialsJson(
    JSON.stringify({
      claudeAiOauth: {
        ...snapshot(100_000).access,
        refreshToken: 'synthetic-source-only',
        subscriptionType: null,
        rateLimitTier: null
      }
    }),
    'credentials-file',
    true
  )
  expect(result.nativeAccess).toMatchObject(snapshot(100_000).access)
  expect(result.nativeAccess).not.toHaveProperty('refreshToken')
})

it('runs native usage without model/tools/MCP/auth environment and checks fresh matching access', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const read = vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValue(snapshot(100_000))
  const run = runner(async (_launch, options) => {
    options.onStdout?.('{"type":"result","subtype":"success","is_error":false}\n')
    options.onClosed?.({ root: 'exited', tree: 'exited' })
    return 'discarded native output'
  })
  const owner = reserve()
  await expect(
    refreshClaudeNativeAccess(source(), { now: () => 1000, read, run, reserve: () => owner })
  ).resolves.toEqual(snapshot(100_000))
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: '/fake/one',
      env: expect.objectContaining({
        HOME: process.platform === 'darwin' ? '/fake/native-user' : '/fake'
      }),
      keepStdinOpen: true,
      stdin: expect.stringContaining('/usage'),
      args: expect.arrayContaining([
        '--tools',
        '',
        '--strict-mcp-config',
        '--no-session-persistence'
      ]),
      envToDelete: expect.arrayContaining([
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_SECURESTORAGE_CONFIG_DIR',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
      ])
    }),
    expect.objectContaining({ timeoutMs: 45_000, maxOutputBytes: 65536 })
  )
  expect(owner.release).toHaveBeenCalledWith({ root: 'exited', tree: 'exited' })
})

it('coalesces one account and serializes native writers across accounts', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  let active = 0
  let peak = 0
  const run = runner(async (_launch, options) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    options.onStdout?.('{"type":"result","subtype":"success","is_error":false}\n')
    options.onClosed?.({ root: 'exited', tree: 'exited' })
    return ''
  })
  const opts = { now: () => 1000, read: vi.fn().mockResolvedValue(snapshot(100_000)), run, reserve }
  const first = refreshClaudeNativeAccess(source(), opts)
  expect(refreshClaudeNativeAccess(source(), opts)).toBe(first)
  await Promise.all([first, refreshClaudeNativeAccess(source('two'), opts)])
  expect(peak).toBe(1)
  expect(run).toHaveBeenCalledTimes(2)
})

it('cooldown skips only fresh snapshots, while expired access forces native refresh', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  let expiresAt = 100_000
  const read = vi.fn(async () => snapshot(expiresAt))
  const run = runner(async (_launch, options) => {
    expiresAt = 100_000
    options.onStdout?.('{"type":"result","subtype":"success","is_error":false}\n')
    options.onClosed?.({ root: 'exited', tree: 'exited' })
    return ''
  })
  const opts = { now: () => 1000, read, run, reserve }
  await refreshClaudeNativeAccess(source(), opts)
  await refreshClaudeNativeAccess(source(), opts)
  expect(run).toHaveBeenCalledTimes(1)
  expiresAt = 1
  await refreshClaudeNativeAccess(source(), opts)
  expect(run).toHaveBeenCalledTimes(2)
})

it('does not accept successful exit with expired credentials or expose native output', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  await expect(
    refreshClaudeNativeAccess(source(), {
      now: () => 1000,
      read: vi.fn().mockResolvedValue(snapshot(1)),
      reserve,
      run: async (_launch, options) => {
        options.onClosed?.({ root: 'exited', tree: 'exited' })
        throw new Error('fake-sensitive-output')
      }
    })
  ).rejects.toThrow('did not produce fresh matching')
})

it('blocks subsequent writers when teardown is unverifiable, retaining the durable receipt', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const owner = {
    ...reserve(),
    release: () => {
      throw new Error('unverifiable')
    }
  }
  const opts = {
    now: () => 1000,
    read: vi.fn().mockResolvedValue(snapshot(1)),
    reserve: () => owner,
    run: runner(async (_launch, options) => {
      options.onClosed?.({ root: 'exited', tree: 'unverifiable' })
      return ''
    })
  }
  await expect(refreshClaudeNativeAccess(source(), opts)).rejects.toThrow(
    'did not produce fresh matching'
  )
  await expect(refreshClaudeNativeAccess(source('two'), opts)).rejects.toThrow(
    'authority is unavailable'
  )
  expect(owner.cancelBeforeSpawn).not.toHaveBeenCalled()
})

it('refuses unqualified native versions and cancelled work before reserving a writer', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const reserveSpy = vi.fn(reserve)
  await expect(
    refreshClaudeNativeAccess({ ...source(), qualifiedVersion: '2.1.92' }, { reserve: reserveSpy })
  ).rejects.toThrow('not qualified')
  await expect(
    refreshClaudeNativeAccess(source(), { reserve: reserveSpy, signal: AbortSignal.abort() })
  ).rejects.toThrow('unavailable')
  expect(reserveSpy).not.toHaveBeenCalled()
})

it.each(['2.1.92', '2.1.319', '2.2.0', '3.0.0', '2.1.318-beta'])(
  'does not label unqualified native %s as supported',
  async (version) => {
    const { supportsClaudeNativeRefreshVersion } = await import('./claude-native-refresh-authority')
    expect(supportsClaudeNativeRefreshVersion(version)).toBe(false)
    expect(supportsClaudeNativeRefreshVersion('2.1.318')).toBe(true)
  }
)

it('cancels only an explicitly proven not-started writer and permits the next refresh attempt', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const owner = reserve(),
    read = vi.fn().mockResolvedValue(snapshot(1))
  const refused = runner(async (_launch, options) => {
    options.onNotStarted?.()
    throw new Error('synthetic no child')
  })
  await expect(
    refreshClaudeNativeAccess(source('no-child'), {
      now: () => 1000,
      read,
      run: refused,
      reserve: () => owner
    })
  ).rejects.toThrow('did not produce')
  expect(owner.cancelBeforeSpawn).toHaveBeenCalledOnce()
  expect(owner.release).not.toHaveBeenCalled()
  read.mockResolvedValueOnce(snapshot(1)).mockResolvedValue(snapshot(100000))
  const run = runner(async (_launch, options) => {
    options.onStdout?.('{"type":"result","subtype":"success","is_error":false}\n')
    options.onClosed?.({ root: 'exited', tree: 'exited' })
    return ''
  })
  await expect(
    refreshClaudeNativeAccess(source('next-proven-child'), {
      now: () => 1000,
      read,
      run,
      reserve: () => owner
    })
  ).resolves.toEqual(snapshot(100000))
  expect(owner.release).toHaveBeenCalledOnce()
})
