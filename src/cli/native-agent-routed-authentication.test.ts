import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { RuntimeClient } from './runtime-client'
import { runNativeAgentExec } from './native-agent-exec'
import { NATIVE_CLAUDE_ROUTING_KEY_ENV } from '../shared/native-claude-hook'
import { resolveUnwrappedNativeCliCommand } from '../shared/native-cli-unwrapped-command'

vi.mock('@orca/process-host', () => ({ spawnProcess: vi.fn() }))
vi.mock('../shared/native-cli-unwrapped-command', () => ({
  resolveUnwrappedNativeCliCommand: vi.fn((_provider, command) => command)
}))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resolveUnwrappedNativeCliCommand).mockImplementation((_provider, command) => command)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
function clientFixture() {
  const client = new RuntimeClient('/fixture-only', 60_000, null, null, '/fixture-only/orca')
  const call = vi.spyOn(client, 'call').mockRejectedValue(new Error('synthetic preparation'))
  return { client, call }
}
const gateway = () => {
  vi.stubEnv(NATIVE_CLAUDE_ROUTING_KEY_ENV, `sk-ant-oat01-${'a'.repeat(64)}`)
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:12345')
}

it.each([
  ['auth', 'login'],
  ['auth', 'status'],
  ['logout'],
  ['setup-token'],
  ['--model', 'auth', 'auth', 'logout'],
  ['--setting-sources', '', 'auth', 'login']
])('keeps routed Claude authentication outside the capability profile (%j)', async (...args) => {
  gateway()
  const { client, call } = clientFixture()
  await expect(
    runNativeAgentExec(client, ['claude', '/synthetic/claude', ...args])
  ).rejects.toThrow('Open a host shell outside the routed session')
  expect(call).not.toHaveBeenCalled()
  expect(spawnProcess).not.toHaveBeenCalled()
})

it.each([
  ['--print', 'auth'],
  ['--', 'auth'],
  ['--resume', 'auth'],
  ['-r', 'login'],
  ['--model', 'auth', '-p', 'logout']
])('preserves literal authentication words in native prompts (%j)', async (...args) => {
  gateway()
  const { client, call } = clientFixture()
  await expect(
    runNativeAgentExec(client, ['claude', '/synthetic/claude', ...args])
  ).rejects.toThrow('synthetic preparation')
  expect(call).toHaveBeenCalledWith('accounts.prepareNativeCliLaunch', expect.any(Object))
  expect(spawnProcess).not.toHaveBeenCalled()
})

it.each(['outside', 'direct-terminal', 'help'])(
  'leaves native authentication and discovery available in %s mode',
  async (mode) => {
    if (mode === 'direct-terminal') {
      vi.stubEnv(NATIVE_CLAUDE_ROUTING_KEY_ENV, 'a'.repeat(64))
      vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:12345')
    } else if (mode === 'help') {
      gateway()
    }
    const { client, call } = clientFixture()
    vi.mocked(spawnProcess).mockImplementation(() => {
      throw new Error('native passthrough')
    })
    const args = mode === 'help' ? ['auth', '--help'] : ['auth', 'login']
    await expect(
      runNativeAgentExec(client, ['claude', '/synthetic/claude', ...args])
    ).rejects.toThrow('native passthrough')
    expect(call).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledWith(expect.objectContaining({ args }))
  }
)
