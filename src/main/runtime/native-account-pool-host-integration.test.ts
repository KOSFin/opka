import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { scriptedCodexTransport } from './scripted-codex-transport.test-fixture'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import type { NativeAccountPoolRuntime } from './native-account-pool-service'
const fake = vi.hoisted(() => ({
  homes: { a: '', b: '' },
  migration: vi.fn(async (..._args: unknown[]) => ({}))
}))
vi.mock('../codex-accounts/worker-account-home', () => ({
  resolveWorkerCodexAccountHome: (_accounts: unknown, id: string) =>
    id === 'a' ? fake.homes.a : fake.homes.b
}))
vi.mock('./account-pool-candidates', () => ({
  accountPoolCandidates: () =>
    ['a', 'b'].map((accountId) => ({
      provider: 'codex',
      accountId,
      quotaIdentity: accountId,
      auth: 'ready',
      quota: 'unknown',
      usedPercent: null
    }))
}))
vi.mock('./account-pool-resume', () => ({
  prepareAccountPoolResume: (...args: unknown[]) => fake.migration(...args)
}))
vi.mock('../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: async () => join(fake.homes.a, 'sessions', 'rollout.jsonl')
}))
let root: string | undefined
let database: OrchestrationDb | undefined
afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  database?.close()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  fake.migration.mockClear()
})
it('rotates a real host from A to B across two sends while preserving provider identity and journal', async () => {
  root = await mkdtemp(join(tmpdir(), 'opka-native-pool-host-'))
  fake.homes.a = join(root, 'account-a')
  fake.homes.b = join(root, 'account-b')
  await mkdir(fake.homes.a)
  await mkdir(fake.homes.b)
  for (const home of Object.values(fake.homes)) {
    const day = join(home, 'sessions', '2026', '10', '30')
    await mkdir(day, { recursive: true })
    await writeFile(
      join(day, `rollout-synthetic-${THREAD}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })}\n`
    )
  }
  database = new OrchestrationDb(':memory:')
  const db = database
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'balanced',
    applyToNewWork: true,
    rotation: 'after-turn',
    unknownQuota: 'allow',
    allowReserve: false,
    members: ['a', 'b'].map((accountId) => ({
      accountId,
      priority: 1,
      weight: 1,
      maxConcurrent: 1,
      state: 'enabled',
      role: 'primary'
    }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pool factory reads only this synthetic snapshot, settings and isolated database.
  const runtime = {
    getOrchestrationDb: () => db,
    getAccountsSnapshot: () => ({}),
    requireStore: () => ({
      getSettings: () => ({ accountPools: [policy], codexManagedAccounts: [] })
    })
  } as unknown as NativeAccountPoolRuntime
  const connections: {
    home: string | undefined
    calls: { method: string; params: unknown }[]
    turns: ReturnType<typeof codexTurnLifecycleFake>
    closed: boolean
  }[] = []
  const openConnection: typeof openCodexAppServerConnection = async (
    launch,
    handlers: CodexAppServerConnectionHandlers = {}
  ) => {
    const calls: { method: string; params: unknown }[] = []
    const turns = codexTurnLifecycleFake(
      THREAD,
      () => (method, params) => handlers.onNotification?.(method, params)
    )
    const entry = { home: launch.env?.CODEX_HOME, calls, turns, closed: false }
    connections.push(entry)
    const connection: CodexAppServerConnection = {
      pid: 4321 + connections.length,
      closed: false,
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: THREAD } }
        }
        if (method === 'turn/start') {
          return turns.routes['turn/start']()
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        entry.closed = true
        return true
      }
    }
    return connection
  }
  const host = await ensureStructuredAgentSessionHost({
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    accountPoolRuntime: runtime,
    logger: createStructuredAgentSessionLogger(),
    resolveWorkspacePath: async () => root!,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveCodexCommand: () => 'codex',
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    ...scriptedCodexTransport(openConnection)
  })
  let operation = 0
  const caller = { callerKey: 'native-pool-host' }
  const params = hostTestAttachParams(null, { providerHandle: undefined })
  params.envelope.clientOperationId = `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`
  const attach = await host.attach(caller, params)
  if (!attach.ok) {
    throw new Error(JSON.stringify(attach.refusal))
  }
  async function send(text: string) {
    const body = hostTestMessage(text)
    const fence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence
    if (fence === undefined) {
      throw new Error('Missing host record')
    }
    const result = await host.send(caller, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body
    })
    if (!result.ok) {
      throw new Error(JSON.stringify(result.refusal))
    }
    return result.value.clientMessageId
  }
  const first = await send('First synthetic task')
  await vi.waitFor(() =>
    expect(connections[0]?.calls.some((call) => call.method === 'turn/start')).toBe(true)
  )
  expect(connections[0].home).toBe(fake.homes.a)
  connections[0].turns.start()
  connections[0].turns.echo(first)
  connections[0].turns.end('completed')
  await vi.waitFor(() => expect(connections[0].closed).toBe(true))
  expect(db.listAccountPoolAssignments()).toHaveLength(0)
  await send('Second synthetic task')
  await vi.waitFor(() =>
    expect(connections[1]?.calls.some((call) => call.method === 'turn/start')).toBe(true)
  )
  expect(connections[1].home).toBe(fake.homes.b)
  expect(connections[1].calls).toContainEqual({
    method: 'thread/resume',
    params: expect.objectContaining({ threadId: THREAD })
  })
  expect(fake.migration).toHaveBeenCalledWith(
    expect.objectContaining({ providerSession: expect.objectContaining({ id: THREAD }) })
  )
  const record = host.deps.store.getRecord(SESSION)
  expect(record?.providerHandleChain.at(-1)?.handle.nativeId).toBe(THREAD)
  expect(record?.accountPool?.accountId).toBe('b')
  const snapshot = await host.journalSnapshot(SESSION)
  expect(JSON.stringify(snapshot)).toContain('First synthetic task')
  expect(JSON.stringify(snapshot)).toContain('Second synthetic task')
})
