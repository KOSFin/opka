import { beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { createNativeCliTerminal } from './native-cli-terminal-create'
const hooks = vi.hoisted(() => ({
  prepare: vi.fn(),
  release: vi.fn(),
  bind: vi.fn(),
  nativeClaude: false
}))
vi.mock('./native-cli-account-launch', () => ({
  prepareNativeCliAccountLaunch: hooks.prepare,
  releaseNativeCliAccountLaunch: hooks.release
}))
vi.mock('./native-claude-routing-ownership', () => ({
  isNativeClaudeRoutingLaunch: () => hooks.nativeClaude,
  attachNativeClaudeRoutingOwner: () => {}
}))
vi.mock('./account-pool-pty-ownership', () => ({ bindAccountPoolPtyExecution: hooks.bind }))
beforeEach(() => {
  vi.resetAllMocks()
  hooks.nativeClaude = false
  hooks.prepare.mockResolvedValue({
    accountId: 'a',
    poolId: 'pool',
    env: { CLAUDE_CONFIG_DIR: '/profiles/a' },
    envToDelete: ['ANTHROPIC_API_KEY']
  })
})
function fixture() {
  const host = {
    dedupeTerminalCreate: vi.fn<OrcaRuntimeService['dedupeTerminalCreate']>(
      async (_caller, selector, _id, _reconcile, create) => create(selector, 'term-native')
    ),
    createTerminal: vi.fn(async (_selector: string, _options: TerminalCreateOptions) => ({
      ptyId: 'native',
      incarnationId: 'incarnation',
      paneKey: 'pane',
      worktreeId: 'global-floating-terminal'
    }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the declared owning-host create surface is used; native process creation is fully synthetic.
  const runtime = host as unknown as OrcaRuntimeService
  return { host, runtime }
}
const params = {
  launchId: '12345678-1234-4234-8234-123456789012',
  provider: 'claude' as const,
  executable: '/native/claude',
  args: ['--model', 'native-model'],
  cwd: '/synthetic/unregistered-folder',
  env: {
    ANTHROPIC_API_KEY: 'synthetic-only',
    MCP_ACCESS: 'synthetic-only',
    ORCA_NATIVE_CLI_PTY_CHILD: 'claude:stale-one-hop'
  },
  cols: 100,
  rows: 30
}
it('owns a floating PTY without registering the user cwd as a project', async () => {
  const f = fixture()
  await createNativeCliTerminal(f.runtime, params)
  expect(f.host.createTerminal).toHaveBeenCalledWith(
    'id:global-floating-terminal',
    expect.objectContaining({
      cwd: params.cwd,
      presentation: 'background',
      surfaceOwner: false,
      activate: false,
      env: expect.objectContaining({
        CLAUDE_CONFIG_DIR: '/profiles/a',
        MCP_ACCESS: 'synthetic-only'
      })
    })
  )
  const launch = f.host.createTerminal.mock.calls[0]?.[1]
  expect(launch?.command).toBe("exec '/native/claude' '--model' 'native-model'")
  expect(launch?.launchConfig?.agentCommand).toBe("'/native/claude' '--model' 'native-model'")
  expect(launch?.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  expect(launch?.env).not.toHaveProperty('ORCA_NATIVE_CLI_PTY_CHILD')
  expect(launch?.launchConfig?.agentEnv).not.toHaveProperty('MCP_ACCESS')
  expect(hooks.bind).toHaveBeenCalledWith(
    f.runtime,
    `native-cli:${params.launchId}`,
    'native',
    'incarnation'
  )
})
it('releases only a reservation whose physical spawn was never dispatched', async () => {
  const f = fixture()
  f.host.createTerminal.mockRejectedValue(new Error('refused before spawn'))
  await expect(createNativeCliTerminal(f.runtime, params)).rejects.toThrow('refused')
  expect(hooks.release).toHaveBeenCalledWith(f.runtime, params.launchId)
})
it('joins repeated creation without preparing a second lease or discarding the private environment', async () => {
  const f = fixture()
  const first = createNativeCliTerminal(f.runtime, params)
  const joined = createNativeCliTerminal(f.runtime, params)
  expect(await joined).toEqual(await first)
  await createNativeCliTerminal(f.runtime, params)
  expect(hooks.prepare).toHaveBeenCalledOnce()
  expect(f.host.createTerminal).toHaveBeenCalledOnce()
})
it('refuses replacing a known managed context whose parent proof is missing', async () => {
  const f = fixture()
  await expect(
    createNativeCliTerminal(f.runtime, { ...params, env: { ORCA_WORKTREE_ID: 'known-worktree' } })
  ).rejects.toThrow('unverifiable')
  expect(hooks.prepare).not.toHaveBeenCalled()
  expect(f.host.createTerminal).not.toHaveBeenCalled()
})
it('applies the prepared Codex transport arguments to the owning external child', async () => {
  const f = fixture()
  hooks.prepare.mockResolvedValue({
    env: { CODEX_HOME: '/profiles/a' },
    envToDelete: [],
    codexConfigOverrides: ['model_provider="opka_runtime"']
  })
  await createNativeCliTerminal(f.runtime, {
    ...params,
    provider: 'codex',
    executable: '/native/codex'
  })
  const launch = f.host.createTerminal.mock.calls[0]?.[1]
  expect(launch?.command).toContain("'-c' 'model_provider=\"opka_runtime\"'")
  expect(launch?.launchConfig?.agentCommand).toContain("'-c' 'model_provider=\"opka_runtime\"'")
})

it('does not reintroduce a static worker quota identity into a registered hot Claude facade', async () => {
  const f = fixture()
  hooks.nativeClaude = true
  await createNativeCliTerminal(f.runtime, {
    ...params,
    launchId: '00000000-0000-4000-8000-000000000003'
  })
  expect(f.host.createTerminal).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      env: expect.not.objectContaining({ ORCA_WORKER_CLAUDE_ACCOUNT_ID: expect.anything() })
    })
  )
  expect(hooks.bind).not.toHaveBeenCalled()
})
