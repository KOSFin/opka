import { beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeNativeRefreshSource } from './claude-native-refresh-authority'
import type { ClaudeNativeAccessSnapshot } from './claude-native-access'
const identity = {
  accountUuid: 'synthetic-account',
  organizationUuid: 'synthetic-org',
  emailAddress: 'synthetic@example.invalid'
}
const snapshot = (expiry = 100000): ClaudeNativeAccessSnapshot => ({
  identity,
  access: { accessToken: 'synthetic-access', expiresAt: expiry, scopes: ['user:inference'] }
})
const source: ClaudeNativeRefreshSource = {
  configDir: '/fake/owner',
  nativeUserHome: '/fake/native-user',
  writerDirectory: '/fake/writer',
  expectedIdentity: identity,
  launch: { command: '/fake/claude', args: [] },
  qualifiedVersion: '2.1.318',
  assertExclusive: vi.fn()
}
const result = '{"type":"result","subtype":"success","is_error":false}\n'
const owner = () => ({ recordGroup: vi.fn(), release: vi.fn(), cancelBeforeSpawn: vi.fn() })
beforeEach(() => vi.resetModules())
it('accepts only its ready-triggered stop and rereads fresh source after proven writer close', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const { AgentModelCatalogProbeError } =
    await import('../native-chat/agent-model-catalog/agent-model-catalog-probe-runner')
  const ordering: string[] = []
  const held = owner()
  held.release.mockImplementation(() => {
    ordering.push('closed')
  })
  const read = vi.fn(async () => {
    ordering.push('read')
    return snapshot()
  })
  await expect(
    refreshClaudeNativeAccess(source, {
      now: () => 1000,
      read,
      reserve: () => held,
      run: async (launch, opts) => {
        expect(launch.keepStdinOpen).toBe(true)
        expect(launch.args).not.toContain('/usage')
        expect(JSON.parse(launch.stdin ?? '')).toEqual({
          type: 'user',
          message: { role: 'user', content: '/usage' },
          parent_tool_use_id: null
        })
        const input = vi.fn(async () => {})
        opts.onStdinReady?.(input)
        expect(input).toHaveBeenCalledWith(launch.stdin)
        opts.onStdout?.(result)
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve()
          } else {
            opts.signal?.addEventListener('abort', () => resolve(), { once: true })
          }
        })
        expect(ordering).not.toContain('closed')
        opts.onClosed?.({ root: 'exited', tree: 'exited' })
        throw new AgentModelCatalogProbeError('controlled fixture stop', 'stopped')
      }
    })
  ).resolves.toEqual(snapshot())
  expect(ordering).toEqual(['read', 'read', 'closed', 'read'])
})
it('does not treat external cancellation as its successful stop even when source became fresh', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const { AgentModelCatalogProbeError } =
    await import('../native-chat/agent-model-catalog/agent-model-catalog-probe-runner')
  const abort = new AbortController()
  const held = owner()
  await expect(
    refreshClaudeNativeAccess(source, {
      signal: abort.signal,
      read: async () => snapshot(),
      reserve: () => held,
      run: async (_launch, opts) => {
        opts.onStdout?.(result)
        abort.abort()
        opts.onClosed?.({ root: 'exited', tree: 'exited' })
        throw new AgentModelCatalogProbeError('external fixture stop', 'stopped')
      }
    })
  ).rejects.toThrow('did not produce')
})
it('rejects a foreign stopped error without an admitted local result', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const { AgentModelCatalogProbeError } =
    await import('../native-chat/agent-model-catalog/agent-model-catalog-probe-runner')
  await expect(
    refreshClaudeNativeAccess(source, {
      read: async () => snapshot(),
      reserve: owner,
      run: async (_launch, opts) => {
        opts.onClosed?.({ root: 'exited', tree: 'exited' })
        throw new AgentModelCatalogProbeError('foreign fixture stop', 'stopped')
      }
    })
  ).rejects.toThrow('did not produce')
})
it('does not publish a source whose identity changes after writer close', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot(1))
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValue({
      ...snapshot(),
      identity: { ...identity, accountUuid: 'different-account' }
    })
  await expect(
    refreshClaudeNativeAccess(source, {
      now: () => 1000,
      read,
      reserve: owner,
      run: async (_launch, opts) => {
        opts.onStdout?.(result)
        await Promise.resolve()
        opts.onClosed?.({ root: 'exited', tree: 'exited' })
        return ''
      }
    })
  ).rejects.toThrow('did not produce')
  expect(read).toHaveBeenCalledTimes(3)
})
it('does not accept overflow and does not expose output in its failure', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  await expect(
    refreshClaudeNativeAccess(source, {
      read: async () => snapshot(),
      reserve: owner,
      run: async (_launch, opts) => {
        opts.onStdout?.('sensitive-fixture'.repeat(5000))
        opts.onClosed?.({ root: 'exited', tree: 'exited' })
        return ''
      }
    })
  ).rejects.toThrow('did not produce fresh matching')
})
it('does not accept ready-stop when durable writer release cannot prove exit', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const held = owner()
  held.release.mockImplementation(() => {
    throw new Error('unverifiable')
  })
  await expect(
    refreshClaudeNativeAccess(source, {
      now: () => 1000,
      read: async () => snapshot(),
      reserve: () => held,
      run: async (_launch, opts) => {
        opts.onStdout?.(result)
        await Promise.resolve()
        opts.onClosed?.({ root: 'exited', tree: 'unverifiable' })
        return ''
      }
    })
  ).rejects.toThrow('did not produce')
  await expect(
    refreshClaudeNativeAccess({ ...source, configDir: '/fake/next' }, { reserve: owner })
  ).rejects.toThrow('unavailable')
})

it('cancels a reservation without launching or poisoning future writers when abort arrives during initial source read', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const abort = new AbortController(),
    held = owner(),
    run = vi.fn(async () => '')
  await expect(
    refreshClaudeNativeAccess(source, {
      signal: abort.signal,
      reserve: () => held,
      run,
      read: async () => {
        abort.abort()
        return snapshot(1)
      }
    })
  ).rejects.toThrow('did not produce')
  expect(run).not.toHaveBeenCalled()
  expect(held.cancelBeforeSpawn).toHaveBeenCalledOnce()
  expect(held.release).not.toHaveBeenCalled()
  await expect(
    refreshClaudeNativeAccess(
      { ...source, configDir: '/fake/after-abort' },
      {
        now: () => 1000,
        read: async () => snapshot(),
        reserve: owner,
        run: async (_launch, opts) => {
          opts.onStdout?.(result)
          opts.onClosed?.({ root: 'exited', tree: 'exited' })
          return ''
        }
      }
    )
  ).resolves.toEqual(snapshot())
})
