import { acquireClaudeNativeScopedAssignment } from './claude-native-scoped-assignment'
import { accountPoolCandidates } from './account-pool-candidates'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { readClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'
import { nativeSourceFixture } from '../claude-accounts/claude-native-source-test-fixtures'
import {
  configureRuntimeClaudeNativeSources,
  getRuntimeClaudeNativeSources,
  registerRuntimeClaudeNativePoolScope,
  shutdownRuntimeClaudeNativeSources
} from './runtime-claude-native-sources'
import { prepareNativeClaudeRoutingLaunch } from './native-claude-routing-launch'
import * as gatewayHttp from '../claude-accounts/claude-native-gateway-http'
import { stageNativeCliStdioOwner } from './native-cli-stdio-owner'
import {
  dispatchNativeClaudeHook,
  dispatchNativeClaudeCoverage
} from './native-claude-hook-sessions'
import {
  attachNativeClaudeRoutingOwner,
  releaseNativeClaudeRoutingOwner
} from './native-claude-routing-ownership'
const hooks = vi.hoisted(() => ({
  owner: { paneKey: 'owned-pane', ptyId: 'owned-pty', incarnationId: 'owned-incarnation' },
  present: true
}))
vi.mock('./native-cli-terminal-owner', () => ({
  createNativeCliTerminalOwnerReader: () => () => (hooks.present ? hooks.owner : null)
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    readNativeClaudePromptId: () => 'native-first-prompt',
    observeNativeClaudeCoverage: (_scope: unknown, request: { sequence: number }) => ({
      sequence: request.sequence,
      healthy: true,
      replayed: false,
      sealedStop: false
    }),
    readNativeClaudeCoverageAvailable: () => true,
    readNativeClaudeAnswerComplete: () => false,
    readNativeClaudeCoverageQuiescent: () => true,
    readNativeClaudeSealedStop: () => true,
    readNativeClaudeFailureBoundary: () => ({
      promptId: undefined,
      canSwitch: () => false,
      onBoundaryAccepted: () => {}
    }),
    readNativeClaudeChildInventory: () => ({ status: 'settled' })
  }
}))
vi.mock('./pty-account-pool-child-inventory', () => ({ readPtyAccountPoolChildren: () => [] }))
vi.mock('../claude/hook-service', () => ({
  ClaudeHookService: class {
    install() {
      return { state: 'installed' }
    }
  }
}))
vi.mock('./account-pool-candidates', () => ({
  accountPoolCandidates: () => [
    {
      provider: 'claude',
      accountId: 'existing-account',
      quotaIdentity: 'existing-account',
      auth: 'ready',
      quota: 'unknown',
      usedPercent: null
    }
  ]
}))
const roots: string[] = []
const databases: OrchestrationDb[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  hooks.present = true
})

it('uses only an opaque capability for staged stdio and joins transport cleanup before retiring its real facade', async () => {
  const f = await fixture()
  hooks.present = false
  const staged = stageNativeCliStdioOwner(f.runtime, f.params.launchId)
  let finishClose = () => {}
  const closing = new Promise<void>((resolve) => {
    finishClose = resolve
  })
  const close = vi.fn(() => closing),
    revoke = vi.fn()
  const start = vi.spyOn(gatewayHttp, 'startClaudeNativeGatewayHttp').mockResolvedValue({
    baseUrl: 'http://127.0.0.1:43210',
    readActiveRequests: () => 0,
    revoke,
    close
  })
  const plan = await prepareNativeClaudeRoutingLaunch(f.runtime, { ...f.params, stdio: true }, true)
  if (!plan) {
    throw new Error('Missing stdio launch')
  }
  const home = plan.env.CLAUDE_CONFIG_DIR
  const credentials = JSON.parse(readFileSync(join(home, '.credentials.json'), 'utf8'))
  expect(credentials.claudeAiOauth.accessToken).toBe(plan.env.OPKA_CLAUDE_ROUTING_KEY)
  expect(credentials.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat01-/)
  expect(credentials.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 365 * 24 * 3600_000)
  expect(JSON.stringify(credentials)).not.toContain('synthetic-new-access')
  expect(JSON.stringify(credentials)).not.toContain('refreshToken')
  expect(plan.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:43210')
  expect(start).toHaveBeenCalledOnce()
  const settings = readFileSync(join(home, 'settings.json'), 'utf8')
  expect(settings).toContain('fake-mcp-key')
  expect(settings).not.toContain('native-pool-hook')
  expect(settings).not.toContain('asyncRewake')
  expect(plan.claudePluginDirs).toHaveLength(1)
  const retiring = releaseNativeClaudeRoutingOwner(f.runtime, f.params.launchId, {
    ownerAbsent: 'not-started'
  })
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(revoke).toHaveBeenCalled()
  expect(existsSync(home)).toBe(true)
  finishClose()
  await retiring
  expect(existsSync(home)).toBe(false)
  expect(f.db.listAccountPoolAssignments().filter((row) => !row.releasedAt)).toHaveLength(0)
  staged.retire()
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})
async function fixture() {
  const f = nativeSourceFixture()
  roots.push(f.root)
  writeFileSync(
    join(f.options.userHome, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'haiku',
      apiKeyHelper: 'foreign-helper',
      mcpServers: { private: { env: { API_KEY: 'fake-mcp-key' } } }
    })
  )
  const policy = {
    id: 'pool',
    provider: 'claude' as const,
    revision: 1,
    strategy: 'balanced' as const,
    applyToNewWork: true,
    rotation: 'after-turn' as const,
    unknownQuota: 'allow' as const,
    allowReserve: false,
    members: [
      {
        accountId: f.account.id,
        priority: 1,
        weight: 1,
        state: 'enabled' as const,
        role: 'primary' as const
      }
    ]
  }
  const row: AgentStatusIpcPayload = {
    paneKey: hooks.owner.paneKey,
    agentType: 'claude',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    turnStartedAt: Date.now(),
    state: 'working',
    prompt: '',
    providerSession: { key: 'session_id', id: 'synthetic-native-session' },
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'synthetic-host',
      incarnation: 1,
      revision: 1,
      observedAt: Date.now()
    },
    mainAgent: { state: 'working', stateStartedAt: Date.now() }
  }
  const listeners = new Set<(change: AgentPaneChange) => void>()
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  vi.spyOn(db, 'releaseAccountPoolAssignment')
  vi.spyOn(db, 'bindAccountPoolAssignmentPty')
  const subscribe = vi.fn(() => vi.fn())
  const host = {
    requireStore: () => ({ getSettings: () => ({ accountPools: [policy] }) }),
    getClientSettings: () => createGlobalSettingsFixture(),
    getAccountsSnapshot: () => ({ claude: { activeAccountId: f.account.id } }),
    getOrchestrationDb: () => db,
    agentTransitions: {
      latestRow: () => row,
      subscribe: (callback: (change: AgentPaneChange) => void) => {
        listeners.add(callback)
        return () => listeners.delete(callback)
      }
    },
    subscribeToPtyExit: subscribe,
    getPtyExecutionHostMetadata: () => ({ incarnationId: hooks.owner.incarnationId }),
    resolveTerminalPane: () => ({
      connected: true,
      executionHostId: 'local',
      ptyId: hooks.owner.ptyId,
      incarnationId: hooks.owner.incarnationId,
      tabId: 'synthetic-tab',
      handle: 'synthetic-handle'
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the declared launch services are exercised; process/PTY proof, native installer and child inventory are explicitly synthetic.
  const runtime = host as unknown as OrcaRuntimeService
  configureRuntimeClaudeNativeSources(runtime, {
    ...f.options,
    resolveHookLaunch: () => ({ command: '/synthetic/owned-opka', args: [] })
  })
  const sources = getRuntimeClaudeNativeSources(runtime)
  if (!sources) {
    throw new Error('Missing source actor')
  }
  await sources.signIn(f.account.id)
  vi.spyOn(sources, 'assertNativeCommand').mockResolvedValue()
  const readAccess = async (accountId: string, signal?: AbortSignal) =>
    f.options.accounts.withNativeRoutingMutation(async () => {
      if (signal?.aborted) {
        throw new Error('Synthetic source stopped')
      }
      sources.assertAccountOwned(accountId)
      const access = await readClaudeNativeAccessSnapshot(
        join(f.sourceRoot, 'claude-profiles', f.attestation().generation, 'home'),
        f.identity
      )
      sources.assertAccountOwned(accountId)
      if (!access) {
        throw new Error('Missing synthetic source access')
      }
      return access
    })
  vi.spyOn(sources, 'refresh').mockImplementation(readAccess)
  const params = {
    provider: 'claude' as const,
    launchId: randomUUID(),
    claudeExecutable: '/synthetic/native-claude'
  }
  return {
    ...f,
    runtime,
    sources,
    readAccess,
    params,
    policy,
    row,
    db,
    subscribe,
    stop: () => {
      row.state = 'done'
      row.mainAgent = { state: 'done', outcome: 'success', stateStartedAt: Date.now() }
      row.claudeNativeBoundaryInventory = 'complete'
      row.turnCompletedAt = Date.now()
      row.receivedAt = Date.now()
      for (const listener of listeners) {
        listener({
          kind: 'observed',
          paneKey: row.paneKey,
          workspace: { worktreeId: 'synthetic', sshHostId: null },
          phase: 'rest',
          at: Date.now()
        })
      }
    }
  }
}
it('connects admission, real source AT projection, facade and hooks around a synthetic refresh process', async () => {
  const f = await fixture(),
    plan = await prepareNativeClaudeRoutingLaunch(f.runtime, f.params)
  if (!plan) {
    throw new Error('Missing native launch')
  }
  const home = plan.env.CLAUDE_CONFIG_DIR
  expect(plan.env.DISABLE_AUTOUPDATER).toBe('1')
  expect(readFileSync(join(home, '.credentials.json'), 'utf8')).not.toContain('refreshToken')
  expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toMatchObject({
    model: 'haiku',
    mcpServers: { private: { env: { API_KEY: 'fake-mcp-key' } } }
  })
  expect(readFileSync(join(home, 'settings.json'), 'utf8')).not.toContain('foreign-helper')
  await dispatchNativeClaudeCoverage(f.runtime, {
    launchId: f.params.launchId,
    capability: plan.env.OPKA_CLAUDE_ROUTING_KEY,
    sessionId: 'synthetic-native-session',
    generation: randomUUID(),
    sequence: 1,
    observation: { kind: 'draft', active: false }
  })
  f.row.receivedAt = Date.now()
  f.row.turnStartedAt = Date.now()
  const common = {
    launchId: f.params.launchId,
    capability: plan.env.OPKA_CLAUDE_ROUTING_KEY,
    sessionId: 'synthetic-native-session',
    promptId: 'native-first-prompt'
  }
  expect(await dispatchNativeClaudeHook(f.runtime, { ...common, event: 'prompt' })).toEqual({
    action: 'allow'
  })
  f.stop()
  expect(await dispatchNativeClaudeHook(f.runtime, { ...common, event: 'stop' })).toEqual({
    action: 'allow'
  })
  expect(f.db.listAccountPoolAssignments().filter((row) => row.releasedAt === null)).toHaveLength(1)
  expect(Math.max(...f.db.listAccountPoolAssignments().map((row) => row.sequence))).toBe(2)
  expect(f.subscribe).toHaveBeenCalledOnce()
  expect(f.db.bindAccountPoolAssignmentPty).toHaveBeenCalledTimes(2)
  expect(plan.envToDelete).toContain('ORCA_WORKER_CLAUDE_ACCOUNT_ID')
  expect(plan.envToDelete).toEqual(
    expect.arrayContaining([
      'ANTHROPIC_BASE_URL',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'CLAUDE_CODE_CUSTOM_OAUTH_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'ANTHROPIC_API_KEY'
    ])
  )
  expect(await releaseNativeClaudeRoutingOwner(f.runtime, f.params.launchId)).toBe(true)
  expect(existsSync(home)).toBe(false)
  expect(
    readFileSync(
      join(
        f.sourceRoot,
        'claude-profiles',
        f.attestation().generation,
        'home',
        '.credentials.json'
      ),
      'utf8'
    )
  ).toContain('refreshToken')
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})
it('waits for an external terminal binding without adopting a fabricated pane', async () => {
  const f = await fixture()
  hooks.present = false
  const plan = await prepareNativeClaudeRoutingLaunch(f.runtime, f.params, true)
  if (!plan) {
    throw new Error('Missing pending terminal launch')
  }
  f.row.receivedAt = Date.now()
  f.row.turnStartedAt = Date.now()
  const request = {
    launchId: f.params.launchId,
    capability: plan.env.OPKA_CLAUDE_ROUTING_KEY,
    sessionId: 'synthetic-native-session',
    promptId: 'native-first-prompt',
    event: 'prompt' as const
  }
  const pending = dispatchNativeClaudeHook(f.runtime, request)
  hooks.present = true
  attachNativeClaudeRoutingOwner(f.runtime, f.params.launchId)
  await dispatchNativeClaudeCoverage(f.runtime, {
    launchId: f.params.launchId,
    capability: plan.env.OPKA_CLAUDE_ROUTING_KEY,
    sessionId: 'synthetic-native-session',
    generation: randomUUID(),
    sequence: 1,
    observation: { kind: 'draft', active: false }
  })
  expect(await pending).toEqual({ action: 'allow' })
  expect(f.subscribe).toHaveBeenCalledOnce()
  await releaseNativeClaudeRoutingOwner(f.runtime, f.params.launchId)
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})
it('rejects a saved pool revision change during refresh and releases only its new assignment', async () => {
  const f = await fixture(),
    refresh = f.readAccess
  vi.spyOn(f.sources, 'refresh').mockImplementationOnce(async (...args) => {
    const access = await refresh(...args)
    f.policy.revision++
    return access
  })
  await expect(prepareNativeClaudeRoutingLaunch(f.runtime, f.params)).rejects.toThrow('changed')
  expect(f.db.releaseAccountPoolAssignment).toHaveBeenCalledOnce()
  expect(f.subscribe).not.toHaveBeenCalled()
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})

it('fences a manual facade too and retains it until an internal native absence proof after unknown release', async () => {
  const f = await fixture()
  const plan = await prepareNativeClaudeRoutingLaunch(f.runtime, {
    ...f.params,
    accountId: f.account.id
  })
  if (!plan) {
    throw new Error('Missing manual facade')
  }
  expect(plan.poolId).toBeNull()
  expect(f.db.listAccountPoolAssignments()).toHaveLength(0)
  expect(
    f.db.db
      .prepare("SELECT COUNT(*) AS count FROM account_pool_native_scopes WHERE provider='claude'")
      .get()
  ).toMatchObject({ count: 1 })
  await releaseNativeClaudeRoutingOwner(f.runtime, f.params.launchId)
  expect(existsSync(plan.env.CLAUDE_CONFIG_DIR)).toBe(true)
  expect(
    f.db.db
      .prepare("SELECT COUNT(*) AS count FROM account_pool_native_scopes WHERE provider='claude'")
      .get()
  ).toMatchObject({ count: 1 })
  await releaseNativeClaudeRoutingOwner(f.runtime, f.params.launchId, {
    ownerAbsent: 'not-started'
  })
  expect(existsSync(plan.env.CLAUDE_CONFIG_DIR)).toBe(false)
  expect(
    f.db.db
      .prepare("SELECT COUNT(*) AS count FROM account_pool_native_scopes WHERE provider='claude'")
      .get()
  ).toMatchObject({ count: 0 })
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})

it('never adopts or releases a retained native assignment through the initial terminal handoff', async () => {
  const f = await fixture()
  const oldScope = registerRuntimeClaudeNativePoolScope(f.runtime)
  const previous = acquireClaudeNativeScopedAssignment(f.db, oldScope, {
    policy: f.policy,
    candidates: accountPoolCandidates(f.runtime.getAccountsSnapshot())
  })
  f.db.bindAccountPoolAssignmentPty({
    ownerKey: previous.ownerKey,
    ptyId: hooks.owner.ptyId,
    incarnationId: hooks.owner.incarnationId
  })
  const plan = await prepareNativeClaudeRoutingLaunch(f.runtime, {
    ...f.params,
    accountId: f.account.id,
    initialAssignmentOwnerKey: previous.ownerKey
  })
  expect(plan?.accountId).toBe(f.account.id)
  expect(plan?.poolId).toBeNull()
  expect(f.db.listAccountPoolAssignments().map((row) => row.ownerKey)).toEqual([previous.ownerKey])
  expect(
    f.db.db
      .prepare("SELECT COUNT(*) AS count FROM account_pool_native_scopes WHERE provider='claude'")
      .get()?.count
  ).toBe(2)
  await releaseNativeClaudeRoutingOwner(f.runtime, f.params.launchId, {
    ownerAbsent: 'not-started'
  })
  expect(f.db.listAccountPoolAssignments().map((row) => row.ownerKey)).toEqual([previous.ownerKey])
  expect(
    f.db.db
      .prepare("SELECT COUNT(*) AS count FROM account_pool_native_scopes WHERE provider='claude'")
      .get()?.count
  ).toBe(1)
  f.db.releaseAccountPoolAssignment(previous.ownerKey)
  oldScope.close()
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})
