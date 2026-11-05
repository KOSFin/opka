import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { installNativeCodexHomeContext } from './native-codex-home-context'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AccountsSnapshot } from './runtime-account-controller'
import {
  engineHostFixture,
  grantContents,
  syntheticTurn
} from '../codex-routing/codex-engine-host-fixture'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import {
  installRuntimeCodexEngineHost,
  type RuntimeCodexEngineInstallOptions,
  listRuntimeCodexRoutingAccounts,
  stopRuntimeCodexEngineHost
} from './runtime-codex-engine-host'
import { publishEngineGrant } from '../codex-routing/engine-grant-files'
import { releaseNativeCliAccountLaunch } from './native-cli-account-launch'
import type { NativeCliAccountLaunch } from '../../shared/native-cli-account-launch'

const routingHooks = vi.hoisted(() => ({
  provider: vi.fn(),
  verify: vi.fn(),
  boundary: vi.fn(),
  supported: vi.fn()
}))
vi.mock('../codex-routing/native-codex-policy-scope', () => ({
  assertNativeCodexPolicyScope: async () => {}
}))
vi.mock('../codex-routing/native-codex-status-hooks', () => ({
  prepareNativeCodexStatusHooks: vi.fn(async () => {})
}))
vi.mock('../agent-cli-version-probe', () => ({
  readAgentCliVersion: async () => ({ version: '0.166.0' })
}))
vi.mock('../codex/native-cli-auth-environment', () => ({
  readNativeCodexModelProvider: routingHooks.provider,
  nativeCodexAuthEnvToDelete: async () => []
}))
vi.mock('./project-task-terminal-proof', () => ({
  verifyProjectTaskTerminalProof: routingHooks.verify
}))
vi.mock('./native-cli-turn-boundary', () => ({
  createNativeCliTurnBoundary: routingHooks.boundary
}))
vi.mock('../codex-routing/codex-engine-capability', () => ({
  supportsCodexEngineGateway: routingHooks.supported
}))

export function nativeRoutingHooks(): {
  provider: Mock
  verify: Mock
  boundary: Mock
  supported: Mock
} {
  return routingHooks
}
export const nativeLaunchId = '70000000-0000-4000-8000-000000000001'
export const nestedLaunchId = '70000000-0000-4000-8000-000000000002'
export const parentProof = {
  terminalHandle: 'term-native',
  paneKey: 'pane-native',
  terminalTaskProof: 'a'.repeat(64)
}
export async function nativeRoutingFixture() {
  routingHooks.provider.mockReset().mockResolvedValue('openai')
  routingHooks.supported.mockReset().mockReturnValue(true)
  routingHooks.verify.mockReset().mockReturnValue({
    hostScope: { kind: 'local' },
    terminalHandle: parentProof.terminalHandle,
    paneKey: parentProof.paneKey,
    processIncarnation: 'incarnation-native',
    launchTokenHash: 'f'.repeat(64)
  })
  routingHooks.boundary.mockReset().mockImplementation(() => ({
    canSwitch: () => true,
    snapshot: () => ({ canSwitch: () => true, onBoundaryAccepted: () => {} }),
    dispose: vi.fn()
  }))
  const f = engineHostFixture()
  await f.host.stop()
  const settings = createGlobalSettingsFixture({
    workspaceDir: f.directory,
    codexManagedAccounts: [...f.accounts.values()].map((account) => ({
      id: account.id,
      email: 'synthetic@example.test',
      providerAccountId: account.providerAccountId,
      managedHomePath: join(f.directory, account.id),
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    accountPools: f.state.policy
      ? [
          {
            ...f.state.policy,
            unknownQuota: 'allow',
            members: f.state.policy.members.map((member) => ({ ...member, maxConcurrent: 1 }))
          }
        ]
      : []
  })
  const snapshot: AccountsSnapshot = {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: settings.codexManagedAccounts ?? [], activeAccountId: f.a.id },
    rateLimits: createEmptyRateLimitState()
  }
  const listeners = new Set<(change: AgentPaneChange) => void>()
  const exits = new Set<() => void>()
  const terminal = { incarnation: 'incarnation-native', connected: true, syncExit: false }
  const sourceHome = join(f.directory, 'unchanged-native-history')
  const home = join(f.directory, 'codex-routing', 'native', 'home')
  const host = {
    requireStore: () => ({ getSettings: () => settings }),
    getAccountsSnapshot: () => snapshot,
    getOrchestrationDb: () => f.db,
    getWorkerCodexAccountEnv: vi.fn(() => ({ CODEX_HOME: join(f.directory, 'legacy-profile') })),
    getCommitMessageAgentEnvironmentResolvers: () => ({
      prepareForCodexLaunch: vi.fn(async () => sourceHome)
    }),
    agentTransitions: {
      latestRow: () => ({ executionId: 'native-execution' }),
      subscribe: vi.fn((listener: (change: AgentPaneChange) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
    },
    getOrchestrationDispatchAuthority: () => ({
      runtimeId: 'synthetic',
      terminalHandle: parentProof.terminalHandle,
      ptyId: 'pty-native',
      worktreeId: 'work-native',
      processIncarnation: terminal.incarnation,
      paneKey: parentProof.paneKey,
      launchTokenHash: 'f'.repeat(64),
      hostScope: { kind: 'local' }
    }),
    resolveTerminalPane: () => ({
      handle: parentProof.terminalHandle,
      tabId: 'tab',
      leafId: 'leaf',
      ptyId: 'pty-native',
      connected: terminal.connected,
      worktreeId: 'work-native',
      executionHostId: 'local',
      hostPlatform: 'linux',
      incarnationId: terminal.incarnation
    }),
    getPtyExecutionHostMetadata: () => ({
      executionHostId: 'local',
      hostPlatform: 'linux',
      incarnationId: terminal.incarnation
    }),
    subscribeToPtyExit: vi.fn((_id: string, listener: () => void) => {
      exits.add(listener)
      if (terminal.syncExit) {
        listener()
      }
      return () => exits.delete(listener)
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The concrete launch surface is supplied above; native process/status/PTY events are isolated synthetic adapters.
  const runtime = host as unknown as OrcaRuntimeService
  const installation: RuntimeCodexEngineInstallOptions = {
    ...f.options,
    userDataPath: f.directory,
    codexAccounts: { withRoutingMutation: (operation) => operation(), setRoutingRemoval: vi.fn() }
  }
  installNativeCodexHomeContext(runtime, {
    storageRoot: f.directory,
    homeDirectory: home,
    resolveSourceHome: () => sourceHome,
    assertExclusive: f.options.assertExclusiveProfile
  })
  installRuntimeCodexEngineHost(runtime, installation)
  for (const account of listRuntimeCodexRoutingAccounts(runtime)) {
    publishEngineGrant(
      join(f.directory, 'codex-routing'),
      account,
      grantContents(account.providerAccountId)
    )
  }
  const plans = new Set<string>()
  return {
    ...f,
    runtime,
    hostAdapters: host,
    settings,
    snapshot,
    terminal,
    listeners,
    exits,
    home,
    sourceHome,
    plans,
    installation,
    cleanup: async () => {
      for (const id of plans) {
        await releaseNativeCliAccountLaunch(runtime, id)
      }
      await stopRuntimeCodexEngineHost(runtime)
      await f.cleanup()
    }
  }
}
export async function nativePlanTurn(plan: NativeCliAccountLaunch, turn = '1') {
  const baseUrl = /openai_base_url\s*=\s*"([^"]+)"/.exec(
    plan.codexConfigOverrides?.join('\n') ?? ''
  )?.[1]
  const home = plan.env.CODEX_HOME
  const apiKey = home
    ? z
        .object({ OPENAI_API_KEY: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))).OPENAI_API_KEY
    : undefined
  if (!baseUrl || !apiKey) {
    throw new Error('Synthetic native plan has no gateway.')
  }
  return syntheticTurn({ baseUrl, apiKey }, turn)
}
