import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { RuntimeClient } from './runtime-client'
import { runNativeAgentExec } from './native-agent-exec'
import { nativeAgentLaunchEnvironment } from './native-agent-launch-environment'
import { resolveUnwrappedNativeCliCommand } from '../shared/native-cli-unwrapped-command'

const terminalHooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('./native-agent-terminal', () => ({ runNativeAgentTerminal: terminalHooks.run }))
vi.mock('@orca/process-host', () => ({ spawnProcess: vi.fn() }))
vi.mock('../shared/native-cli-unwrapped-command', () => ({
  resolveUnwrappedNativeCliCommand: vi.fn((_provider, command) => command)
}))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resolveUnwrappedNativeCliCommand).mockImplementation((_provider, command) => command)
  vi.unstubAllEnvs()
})

it.each([['login'], ['logout'], ['auth', 'status'], ['--remote', 'http://example.invalid']])(
  'never exposes the owned local gateway credential through unmanaged %s',
  async (...args) => {
    const f = fixture()
    vi.stubEnv('OPKA_CODEX_ROUTING_KEY', 'synthetic-launch-nonce')
    await expect(
      runNativeAgentExec(f.client, ['codex', '/synthetic/codex', ...args])
    ).rejects.toThrow('Open a host shell')
    expect(f.call).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
  }
)
function fixture(
  outcome: 'exit' | 'spawn-error' | 'unverifiable' = 'exit',
  codexConfigOverrides?: string[],
  executionMode?: 'inherit' | 'host-pty'
) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
  vi.mocked(spawnProcess).mockImplementation(() => {
    queueMicrotask(() => {
      if (outcome !== 'spawn-error') {
        child.emit('spawn')
      }
      if (outcome === 'exit') {
        child.emit('exit', 7, null)
      } else {
        child.emit('error', new Error('synthetic failure'))
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The runner only uses the fake's event and kill surface; no native process is started.
    return child as unknown as ReturnType<typeof spawnProcess>
  })
  const call = vi.fn(async (method: string, _params?: unknown) => ({
    result:
      method === 'accounts.prepareNativeCliLaunch'
        ? {
            env: { CLAUDE_CONFIG_DIR: '/profiles/a' },
            codexConfigOverrides,
            executionMode,
            envToDelete: ['ORCA_NATIVE_CLI_ACCOUNT_PIN', 'ANTHROPIC_API_KEY']
          }
        : { released: true }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The synthetic local client implements the only RPC call surface used by the runner.
  const client = { call } as unknown as Pick<RuntimeClient, 'call'>
  return { call, client, child }
}
it('preserves native arguments, inherited streams and exit status while releasing on actual exit', async () => {
  const f = fixture()
  vi.stubEnv('ORCA_NATIVE_CLI_ACCOUNT_PIN', 'claude:a')
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-only')
  const args = [
    '--model',
    'native-model',
    '-p',
    'literal $input with spaces',
    '--output-format=json'
  ]
  expect(await runNativeAgentExec(f.client, ['claude', '/synthetic/claude', ...args])).toBe(7)
  expect(spawnProcess).toHaveBeenCalledWith(
    expect.objectContaining({ program: '/synthetic/claude', args, stdio: 'inherit' })
  )
  expect(f.call).toHaveBeenCalledWith(
    'accounts.prepareNativeCliLaunch',
    expect.objectContaining({ claudeExecutable: '/synthetic/claude' })
  )
  const env = vi.mocked(spawnProcess).mock.calls[0]?.[0].env
  expect(env?.CLAUDE_CONFIG_DIR).toBe('/profiles/a')
  expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env?.ORCA_NATIVE_CLI_ACCOUNT_PIN).toBeUndefined()
  expect(f.call.mock.calls.map(([method]) => method)).toEqual([
    'accounts.prepareNativeCliLaunch',
    'accounts.releaseNativeCliLaunch'
  ])
})
it('applies host routing overrides without swallowing the native literal prompt', async () => {
  const f = fixture('exit', ['model_provider="opka_runtime"'])
  await runNativeAgentExec(f.client, [
    'codex',
    '/synthetic/codex',
    'exec',
    '-m',
    'native-model',
    '--',
    'literal prompt'
  ])
  expect(vi.mocked(spawnProcess).mock.calls[0]?.[0].args).toEqual([
    '--no-daemon',
    'exec',
    '-m',
    'native-model',
    '-c',
    'model_provider="opka_runtime"',
    '--',
    'literal prompt'
  ])
})
it('releases a reservation when process creation definitively fails', async () => {
  const f = fixture('spawn-error')
  await expect(
    runNativeAgentExec(f.client, ['codex', '/synthetic/codex', 'exec', '--json'])
  ).rejects.toThrow('synthetic')
  expect(f.call).toHaveBeenCalledTimes(2)
})
it('retains a reservation when an already-started child exit is unverifiable', async () => {
  const f = fixture('unverifiable')
  const running = runNativeAgentExec(f.client, ['claude', '/synthetic/claude'])
  await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
  expect(f.call).toHaveBeenCalledTimes(1)
  f.child.emit('exit', 7, null)
  expect(await running).toBe(7)
  expect(f.call).toHaveBeenCalledTimes(2)
})
it('refuses a nonabsolute executable before acquiring an account', async () => {
  const f = fixture()
  await expect(runNativeAgentExec(f.client, ['claude', 'claude'])).rejects.toThrow(
    'absolute executable'
  )
  expect(f.call).not.toHaveBeenCalled()
})
it('does not carry a Claude account pin into a Codex child', async () => {
  const f = fixture()
  vi.stubEnv('ORCA_NATIVE_CLI_ACCOUNT_PIN', 'claude:a')
  await runNativeAgentExec(f.client, ['codex', '/synthetic/codex', 'exec', '--json'])
  expect(f.call.mock.calls[0]?.[1]).toMatchObject({ provider: 'codex' })
  expect(f.call.mock.calls[0]?.[1]).not.toHaveProperty('accountId')
})
it('strips competing auth case-insensitively on Windows while preserving custom credentials', () => {
  const env = nativeAgentLaunchEnvironment(
    { anthropic_api_key: 'synthetic', CUSTOM_PROVIDER_KEY: 'synthetic' },
    { env: { CLAUDE_CONFIG_DIR: 'C:\\profiles\\a' }, envToDelete: ['ANTHROPIC_API_KEY'] },
    'win32'
  )
  expect(env.anthropic_api_key).toBeUndefined()
  expect(env.CUSTOM_PROVIDER_KEY).toBe('synthetic')
})
it('does not let an inherited PTY marker bypass a separately spawned native CLI admission', async () => {
  const f = fixture()
  vi.stubEnv('ORCA_NATIVE_CLI_PTY_CHILD', 'claude:12345678-1234-4234-8234-123456789012')
  expect(await runNativeAgentExec(f.client, ['claude', '/synthetic/claude'])).toBe(7)
  expect(f.call.mock.calls.map(([method]) => method)).toEqual([
    'accounts.prepareNativeCliLaunch',
    'accounts.releaseNativeCliLaunch'
  ])
  expect(vi.mocked(spawnProcess).mock.calls[0]?.[0].env).not.toHaveProperty(
    'ORCA_NATIVE_CLI_PTY_CHILD'
  )
})
it('does not inherit a parent Codex routing capability into a separately spawned CLI', async () => {
  const f = fixture()
  vi.stubEnv('ORCA_NATIVE_CLI_PTY_CHILD', 'codex:12345678-1234-4234-8234-123456789012')
  vi.stubEnv('OPKA_CODEX_ROUTING_KEY', 'synthetic-owned-transport-capability')
  await runNativeAgentExec(f.client, ['codex', '/synthetic/codex', 'exec', 'synthetic'])
  expect(f.call.mock.calls[0]?.[0]).toBe('accounts.prepareNativeCliLaunch')
  expect(vi.mocked(spawnProcess).mock.calls[0]?.[0].env?.OPKA_CODEX_ROUTING_KEY).toBeUndefined()
  vi.stubEnv('ORCA_NATIVE_CLI_PTY_CHILD', '')
  await runNativeAgentExec(f.client, ['codex', '/synthetic/codex', '--help'])
  expect(vi.mocked(spawnProcess).mock.calls[1]?.[0].env?.OPKA_CODEX_ROUTING_KEY).toBeUndefined()
})
it('sets only the fresh prepared routing capability after removing the inherited key', () => {
  const env = nativeAgentLaunchEnvironment(
    { OPKA_CODEX_ROUTING_KEY: 'synthetic-parent' },
    {
      env: { OPKA_CODEX_ROUTING_KEY: 'synthetic-new-child' },
      envToDelete: []
    }
  )
  expect(env.OPKA_CODEX_ROUTING_KEY).toBe('synthetic-new-child')
})
it.each([
  ['codex', '--no-daemon', '--help'],
  ['claude', 'auth', 'login']
])('preserves native auth/help without consulting the account broker (%j)', async (...args) => {
  const f = fixture()
  const [provider, ...nativeArgs] = args
  expect(
    await runNativeAgentExec(f.client, [provider, `/synthetic/${provider}`, ...nativeArgs])
  ).toBe(7)
  expect(f.call).not.toHaveBeenCalled()
})

function interactiveStdio() {
  const restore: (() => void)[] = []
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY')
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true })
    restore.push(() =>
      descriptor
        ? Object.defineProperty(stream, 'isTTY', descriptor)
        : Reflect.deleteProperty(stream, 'isTTY')
    )
  }
  return () => {
    for (const undo of restore) {
      undo()
    }
  }
}
it('uses one deferred host-PTY preparation for an external interactive command', async () => {
  const restore = interactiveStdio()
  const f = fixture('exit', undefined, 'host-pty')
  terminalHooks.run.mockResolvedValue(37)
  try {
    expect(
      await runNativeAgentExec({ ...f.client, userDataPath: '/synthetic', isRemote: false }, [
        'claude',
        '/native/claude'
      ])
    ).toBe(37)
    expect(f.call).toHaveBeenCalledOnce()
    expect(f.call.mock.calls[0]?.[1]).toMatchObject({ interactive: true })
    expect(terminalHooks.run).toHaveBeenCalledOnce()
    expect(spawnProcess).not.toHaveBeenCalled()
  } finally {
    restore()
  }
})
it('sends the actual injected parent proof to the host and retains project/task/hook context in direct stdio', async () => {
  const restore = interactiveStdio()
  const root = mkdtempSync(join(tmpdir(), 'opka-parent-proof-'))
  const directory = join(root, 'terminal-task-callers')
  mkdirSync(directory)
  const proof = 'a'.repeat(64)
  const path = join(directory, `${'b'.repeat(64)}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      proof,
      identity: {
        terminalHandle: 'term-parent',
        paneKey: 'pane-parent',
        worktreeId: 'workspace-parent',
        processIncarnation: 'incarnation'
      }
    }),
    { mode: 0o600 }
  )
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  vi.stubEnv('ORCA_TERMINAL_TASK_CALLER_FILE', path)
  vi.stubEnv('ORCA_PANE_KEY', 'pane-parent')
  vi.stubEnv('ORCA_WORKTREE_ID', 'workspace-parent')
  vi.stubEnv('ORCA_AGENT_HOOK_TOKEN', 'synthetic-hook-only')
  const f = fixture('exit', undefined, 'inherit')
  try {
    expect(await runNativeAgentExec(f.client, ['claude', '/native/claude'])).toBe(7)
    expect(f.call.mock.calls[0]?.[1]).toMatchObject({
      interactive: true,
      parentContextExpected: true,
      parentTerminal: {
        terminalHandle: 'term-parent',
        paneKey: 'pane-parent',
        terminalTaskProof: proof
      }
    })
    expect(terminalHooks.run).not.toHaveBeenCalled()
    expect(vi.mocked(spawnProcess).mock.calls[0]?.[0].env).toMatchObject({
      ORCA_PANE_KEY: 'pane-parent',
      ORCA_WORKTREE_ID: 'workspace-parent',
      ORCA_TERMINAL_TASK_CALLER_FILE: path,
      ORCA_AGENT_HOOK_TOKEN: 'synthetic-hook-only'
    })
  } finally {
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

it('executes the verified native command instead of recursively launching a managed shim', async () => {
  const f = fixture()
  vi.mocked(resolveUnwrappedNativeCliCommand).mockReturnValue('/synthetic/native-codex')
  await runNativeAgentExec(f.client, ['codex', '/synthetic/managed/codex', 'exec', 'synthetic'])
  expect(resolveUnwrappedNativeCliCommand).toHaveBeenCalledWith('codex', '/synthetic/managed/codex')
  expect(spawnProcess).toHaveBeenCalledWith(
    expect.objectContaining({ program: '/synthetic/native-codex' })
  )
})
