import { expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { NATIVE_AGENT_EXEC_HANDLERS } from './native-agent-exec'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

vi.mock('../native-agent-exec', () => ({ runNativeAgentExec: vi.fn() }))
vi.mock('../native-agent-terminal', () => ({ attachNativeAgentTerminal: vi.fn() }))
vi.mock('../native-claude-pool-hook', () => ({ runNativeClaudePoolHook: vi.fn() }))
vi.mock('../format', () => ({ printResult: vi.fn() }))

it.each([
  ['status', 'accounts.nativeCliIntegrationStatus'],
  ['install', 'accounts.installNativeCliIntegration'],
  ['uninstall', 'accounts.uninstallNativeCliIntegration']
])(
  'routes native-shell %s to the local owning host without caller paths',
  async (action, method) => {
    const call = vi.fn(async () => ({ result: { changed: true } }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler reads only isRemote and calls the mocked RPC method.
    const client = { isRemote: false, call } as unknown as RuntimeClient
    await NATIVE_AGENT_EXEC_HANDLERS[`agent native-shell ${action}`]({
      client,
      json: true,
      cwd: '/synthetic',
      flags: new Map()
    })
    expect(call).toHaveBeenCalledExactlyOnceWith(method)
    expect(printResult).toHaveBeenCalled()
  }
)
it('refuses remote setup before sending a request', async () => {
  const call = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The remote guard runs before any other client member is used.
  const client = { isRemote: true, call } as unknown as RuntimeClient
  await expect(
    NATIVE_AGENT_EXEC_HANDLERS['agent native-shell install']({
      client,
      json: true,
      cwd: '/synthetic',
      flags: new Map()
    })
  ).rejects.toThrow('execution host')
  expect(call).not.toHaveBeenCalled()
})

it('routes native HOME status to the owning host without reading caller config', async () => {
  const call = vi.fn(async () => ({ result: { state: 'prepared' } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler only uses the mocked call and isRemote fields.
  const client = { isRemote: false, call } as unknown as RuntimeClient
  await NATIVE_AGENT_EXEC_HANDLERS['agent native-home status']({
    client,
    json: true,
    cwd: '/synthetic',
    flags: new Map(),
    rawArgs: ['work']
  })
  expect(call).toHaveBeenCalledExactlyOnceWith('accounts.inspectNativeCodexHome', {
    profile: 'work'
  })
})

it('explains the manual fallback on an older host without mutating its HOME', async () => {
  const call = vi.fn(async () => {
    throw new RuntimeClientError('method_not_found', 'Unknown method')
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler only uses the mocked call and isRemote fields.
  const client = { isRemote: false, call } as unknown as RuntimeClient
  await expect(
    NATIVE_AGENT_EXEC_HANDLERS['agent native-home status']({
      client,
      json: true,
      cwd: '/synthetic',
      flags: new Map()
    })
  ).rejects.toThrow('manual native Codex')
  expect(call).toHaveBeenCalledOnce()
})
