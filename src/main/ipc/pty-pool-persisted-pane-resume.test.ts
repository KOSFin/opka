import { expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  installRestartHarness,
  leafId,
  paneKey,
  registerWithFakes,
  tabId,
  worktreeId
} from './pty-pane-owner-swap.test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => {
    const mocked = m.agentHookServerModuleMock()
    return {
      ...mocked,
      agentHookServer: { ...mocked.agentHookServer, recordLaunchResumeIdentity: vi.fn() }
    }
  })
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

import { agentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimePtyController } from '../runtime/runtime-pty-controller-contract'

const { mainWindow } = setupPtyIpcSuite()

it('recreates a stopped persisted pane through real terminal creation and host spawn admission', async () => {
  const f = installRestartHarness({ oldSessionAbsent: true })
  Object.assign(f.store, {
    getSettings: () => ({
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      agentWorkspaceTrustEnabled: false
    }),
    getRepos: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => []
  })
  registerWithFakes(mainWindow, f.runtime, f.store)
  const registeredController = f.runtime.setPtyController.mock.calls.at(-1)?.[0]
  if (!registeredController || typeof registeredController !== 'object') {
    throw new Error('The host did not register a runtime terminal controller')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerPtyHandlers supplied this actual controller to the captured setter.
  const controller = registeredController as RuntimePtyController
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture contains the real mutable binding operations and runtime-read settings/session methods.
  const runtime = new OrcaRuntimeService(f.store as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async () => ({
      id: worktreeId,
      path: '/tmp/restart',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
  })
  runtime.setPtyController(controller)
  if (!controller.stopAndWait) {
    throw new Error('The host did not register stopAndWait')
  }
  await expect(controller.stopAndWait('pty-old', { keepHistory: true })).resolves.toBe(true)
  expect(f.shutdown).toHaveBeenCalledWith('pty-old', expect.objectContaining({ keepHistory: true }))
  expect(f.leafBinding()).toBe('pty-old')
  const resumed = {
    key: 'session_id' as const,
    id: 'same-conversation',
    transcriptPath: '/synthetic/target/sessions/rollout.jsonl'
  }
  const result = await runtime.createTerminal(`id:${worktreeId}`, {
    tabId,
    leafId,
    command: 'codex resume same-conversation',
    launchAgent: 'codex',
    env: { CODEX_HOME: '/synthetic/target' },
    resumeProviderSession: resumed,
    requireFreshPane: true,
    activate: false,
    focus: false
  })
  expect(result.ptyId).toBe('pty-new')
  expect(agentHookServer.recordLaunchResumeIdentity).toHaveBeenCalledWith(
    expect.objectContaining({ paneKey, providerSession: resumed, agentType: 'codex' })
  )
  expect(f.leafBinding()).toBe('pty-new')
  expect(f.store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey[paneKey]).toBe('inc-new')
  const attach = f.providerSpawn.mock.calls.find(([options]) => options.attachOnly)?.[0]
  expect(attach).toMatchObject({ sessionId: 'pty-old', attachOnly: true })
  const fresh = f.providerSpawn.mock.calls.filter(([options]) => !options.attachOnly)
  expect(fresh).toHaveLength(1)
  expect(fresh[0]?.[0]).toMatchObject({
    command: 'codex resume same-conversation',
    env: expect.objectContaining({ CODEX_HOME: '/synthetic/target' })
  })
  expect(fresh[0]?.[0]).not.toHaveProperty('sessionId', 'pty-old')
  expect(f.store.getWorkspaceSession().tabsByWorktree[worktreeId]).toHaveLength(1)
})
