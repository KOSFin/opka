import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import { PtyAccountPoolRotation } from './pty-account-pool-rotation'
const hooks = vi.hoisted(() => ({ snapshot: vi.fn(), resume: vi.fn(), policy: vi.fn() }))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { getCanonicalStatusSnapshot: hooks.snapshot }
}))
vi.mock('./account-pool-resume', () => ({ prepareAccountPoolResume: hooks.resume }))
vi.mock('./runtime-account-pool-policy', () => ({ getAccountPoolPolicy: hooks.policy }))
vi.mock('./account-pool-rotation-policy', () => ({
  selectAccountPoolRotationMember: () => ({ provider: 'codex', id: 'b', quotaIdentity: 'b' })
}))
vi.mock('./account-pool-candidates', () => ({
  accountPoolCandidates: () => [
    { provider: 'codex', accountId: 'a', auth: 'ready', quota: 'exhausted', quotaIdentity: 'a' },
    { provider: 'codex', accountId: 'b', auth: 'ready', quota: 'available', quotaIdentity: 'b' }
  ]
}))
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  vi.resetAllMocks()
})
afterEach(() => vi.useRealTimers())
function fixture() {
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'balanced',
    applyToNewWork: true,
    rotation: 'on-limit',
    unknownQuota: 'allow',
    allowReserve: false,
    members: ['a', 'b'].map((accountId) => ({
      accountId,
      priority: 1,
      weight: 1,
      state: 'enabled',
      role: 'primary'
    }))
  }
  hooks.policy.mockReturnValue(policy)
  const row: AgentStatusIpcPayload = {
    paneKey: 'synthetic',
    worktreeId: 'workspace',
    executionId: 'execution-a',
    connectionId: null,
    receivedAt: 9000,
    stateStartedAt: 9000,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    mainAgent: { state: 'done', stateStartedAt: 9000, outcome: 'success' },
    turnStartedAt: 8000,
    turnCompletedAt: 9000,
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'host',
      incarnation: 1,
      revision: 2,
      observedAt: 9000
    },
    providerSession: {
      key: 'session_id',
      id: 'conversation',
      transcriptPath: '/synthetic/a/sessions/rollout.jsonl'
    }
  }
  const subject = {
    kind: 'pty-run',
    runId: 'run',
    executionHostId: 'local',
    workspaceId: 'workspace',
    workspaceKind: 'folder',
    wslDistro: null
  }
  hooks.snapshot.mockReturnValue({ parents: [{ subject, status: row }], children: [], aliases: [] })
  hooks.resume.mockImplementation(async (args) => args.providerSession)
  const db = {
    listAccountPoolAssignments: vi.fn(() => [
      {
        ownerKey: 'previous',
        ptyId: 'pty-a',
        incarnationId: 'incarnation-a',
        accountId: 'a',
        poolId: 'pool'
      }
    ]),
    acquireAccountPoolAssignment: vi.fn(() => ({ ownerKey: 'next', accountId: 'b' })),
    releaseAccountPoolAssignment: vi.fn(),
    bindAccountPoolAssignmentPty: vi.fn()
  }
  let lastInputAt = 8000
  const host = {
    agentTransitions: { latestRow: () => row },
    resolveTerminalPane: () => ({
      ptyId: 'pty-a',
      incarnationId: 'incarnation-a',
      executionHostId: 'local'
    }),
    getOrchestrationDb: () => db,
    getAccountsSnapshot: () => ({}),
    terminalRunFacts: {
      read: () => ({ firstUserInputAt: 8000 }),
      readLastInputAt: () => lastInputAt
    },
    requireStore: () => ({
      getSettings: () => ({ agentCmdOverrides: {}, accountPools: [policy] })
    }),
    getWorkerCodexAccountEnv: (id: string) => ({
      CODEX_HOME: `/synthetic/${id}`,
      ORCA_WORKER_CODEX_ACCOUNT_ID: id
    }),
    stopExactTerminalsForWorktree: vi.fn(async (_workspace, _ids, options) => {
      options.beforeStop()
      return { postStopVerified: true }
    }),
    createTerminal: vi.fn(async (_workspace, options) => {
      options.onPtySpawnDispatched()
      return { ptyId: 'pty-b', incarnationId: 'incarnation-b' }
    }),
    subscribeToPtyExit: vi.fn(),
    getPtyExecutionHostMetadata: () => ({ incarnationId: 'incarnation-b' })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The synthetic owning host implements the complete controller surface; no real runtime or accounts are used.
  const runtime = host as unknown as OrcaRuntimeService
  const controller = new PtyAccountPoolRotation(runtime, () => ({
    isWsl: false,
    wslDistro: null,
    launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
  }))
  return {
    controller,
    host,
    db,
    row,
    policy,
    input: () => {
      lastInputAt++
    }
  }
}
function finish(f: ReturnType<typeof fixture>) {
  // A valid pane identity is required by the real parser.
  f.row.paneKey = 'tab_12345678-1234-1234-1234-123456789012:12345678-1234-4234-8234-123456789012'
  f.controller.observe({
    kind: 'moved',
    paneKey: f.row.paneKey,
    workspace: { worktreeId: 'workspace', sshHostId: null },
    from: 'working',
    to: 'done',
    transition: 'turn-finished',
    at: 9000
  })
  return vi.advanceTimersByTimeAsync(2000)
}
it('resumes the exact conversation in the same pane after a verified exit', async () => {
  const f = fixture()
  await finish(f)
  expect(f.host.stopExactTerminalsForWorktree).toHaveBeenCalledOnce()
  expect(f.host.createTerminal).toHaveBeenCalledWith(
    'id:workspace',
    expect.objectContaining({
      resumeProviderSession: f.row.providerSession,
      activate: false,
      requireFreshPane: true
    })
  )
  expect(f.db.bindAccountPoolAssignmentPty).toHaveBeenCalledWith({
    ownerKey: 'next',
    ptyId: 'pty-b',
    incarnationId: 'incarnation-b'
  })
})
it('keeps the previous process when history preparation fails', async () => {
  const f = fixture()
  hooks.resume.mockRejectedValue(new Error('unverified history'))
  await finish(f)
  expect(f.host.stopExactTerminalsForWorktree).not.toHaveBeenCalled()
  expect(f.db.releaseAccountPoolAssignment).toHaveBeenCalledWith('next')
  expect(f.db.releaseAccountPoolAssignment).not.toHaveBeenCalledWith('previous')
})
it('cancels before stopping when input arrived during preparation', async () => {
  const f = fixture()
  hooks.resume.mockImplementation(async (args) => {
    f.input()
    return args.providerSession
  })
  await finish(f)
  expect(f.host.stopExactTerminalsForWorktree).not.toHaveBeenCalled()
  expect(f.host.createTerminal).not.toHaveBeenCalled()
})
it('retains an ambiguous replacement allocation and never resubmits the prompt', async () => {
  const f = fixture()
  f.host.createTerminal.mockImplementation(async (_workspace, options) => {
    options.onPtySpawnDispatched()
    throw new Error('lost reply')
  })
  await finish(f)
  expect(f.db.releaseAccountPoolAssignment).toHaveBeenCalledWith('previous')
  expect(f.db.releaseAccountPoolAssignment).not.toHaveBeenCalledWith('next')
  expect(f.host.createTerminal).toHaveBeenCalledOnce()
})
it('does not switch with rotation disabled', async () => {
  const f = fixture()
  f.policy.rotation = 'off'
  await finish(f)
  expect(f.db.acquireAccountPoolAssignment).not.toHaveBeenCalled()
})
