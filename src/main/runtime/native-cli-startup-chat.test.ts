import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { NativeCliStartup } from './native-cli-startup'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import type { RuntimeStore } from './runtime-store-contract'

it('terminal-backed chat holds its host operation then replays a specific failed start', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createAgentSession reads only these settings from the synthetic store; terminal execution is replaced below.
  const runtime = new OrcaRuntimeService({
    getSettings: () => ({ disabledTuiAgents: [] })
  } as unknown as RuntimeStore)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async () => ({
      id: 'folder:synthetic',
      path: '/synthetic',
      connectionId: null
    }),
    executionOwnerSupportsAgentSessionOperation: async () => true
  })
  const startup = new NativeCliStartup('raw', 'token', 'codex')
  vi.spyOn(runtime, 'getNativeCliStartupForHandle').mockReturnValue(startup)
  const create = vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_worktree, opts) => {
    opts?.onPtySpawnCommitted?.()
    return {
      handle: 'term_chat',
      tabId: 'tab_fixture',
      paneKey: 'tab_fixture:77777777-7777-4777-8777-777777777777',
      ptyId: 'pty_chat',
      worktreeId: 'folder:synthetic',
      title: null,
      surface: 'background'
    }
  })
  const request = {
    clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
    worktree: 'id:folder:synthetic',
    agent: 'codex' as const,
    viewMode: 'chat' as const
  }
  const pending = runtime.createAgentSession(request)
  const failure = expect(pending).rejects.toMatchObject({ code: 'native_cli_config_conflict' })
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
  expect(create.mock.calls[0][1]).toMatchObject({
    viewMode: 'chat',
    startupAgent: 'codex',
    agentSessionCreateOperationId: expect.any(String)
  })
  startup.begin('initial')
  startup.refuse('initial', new NativeCliControlError('config_conflict'))
  await failure
  await expect(runtime.createAgentSession(request)).rejects.toMatchObject({
    code: 'native_cli_config_conflict'
  })
  expect(create).toHaveBeenCalledOnce()
})
