import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import {
  createNativeAccountPoolService,
  type NativeAccountPoolRuntime
} from './native-account-pool-service'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { NativeAccountRotationBoundary } from '../native-chat/agent-session-wire/structured-account-acquisition'
import type { AgentSessionRecordStore } from './agent-session-record-store'

const mocks = vi.hoisted(() => ({
  quota: 'unknown',
  unavailable: false,
  copy: vi.fn(async (..._args: unknown[]) => ({})),
  transcript: vi.fn(async () => '/synthetic/pool-home/sessions/rollout.jsonl')
}))
vi.mock('../codex-accounts/worker-account-home', () => ({
  resolveWorkerCodexAccountHome: (_accounts: unknown, id: string) =>
    id === 'a' ? '/synthetic/pool-home' : '/synthetic/pool-home-b'
}))
vi.mock('./account-pool-resume', () => ({
  prepareAccountPoolResume: (...args: unknown[]) => mocks.copy(...args)
}))
vi.mock('../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: () => mocks.transcript()
}))
vi.mock('./account-pool-candidates', () => ({
  accountPoolCandidates: () =>
    ['a', 'b'].map((id) => ({
      provider: 'codex',
      accountId: id,
      quotaIdentity: `quota-${id}`,
      auth: id === 'b' && mocks.unavailable ? 'unavailable' : 'ready',
      quota: id === 'a' ? mocks.quota : 'unknown',
      usedPercent: null
    }))
}))
let db: OrchestrationDb | undefined
afterEach(() => {
  db?.close()
  mocks.quota = 'unknown'
  mocks.unavailable = false
  mocks.copy.mockReset().mockResolvedValue({})
  mocks.transcript.mockReset().mockResolvedValue('/synthetic/pool-home/sessions/rollout.jsonl')
})
function fixture() {
  db = new OrchestrationDb(':memory:')
  const database = db
  let record = agentSessionRecordFixture()
  record.provider = 'codex'
  record.accountHome = { variable: 'CODEX_HOME', path: '/synthetic/old-home' }
  record.providerHandleChain = []
  record.lease.claimStatus = 'reserved'
  record.lease.ownerProcess = null
  record.lease.provenHandleLinkId = null
  record.lease.reservedSpawnToken = 'generation-a'
  record.location = { ...record.location, executionHostId: 'local', wslDistro: null }
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'balanced',
    applyToNewWork: true,
    rotation: 'off',
    unknownQuota: 'allow',
    allowReserve: false,
    members: [
      {
        accountId: 'a',
        priority: 1,
        weight: 1,
        maxConcurrent: 1,
        state: 'enabled',
        role: 'primary'
      }
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This service reads only settings, candidates and its isolated database.
  const runtime = {
    getOrchestrationDb: () => database,
    getAccountsSnapshot: () => ({}),
    requireStore: () => ({
      getSettings: () => ({ accountPools: [policy], codexManagedAccounts: [] })
    })
  } as unknown as NativeAccountPoolRuntime
  const store: Pick<AgentSessionRecordStore, 'reviseSessionRecord'> = {
    reviseSessionRecord: async (revise, args) => {
      record = revise(record, args)
      return record
    }
  }
  return {
    service: createNativeAccountPoolService({ runtime, store }),
    database,
    policy,
    store,
    read: () => record
  }
}
it('reserves nothing until actual acquisition and persists the chosen identity', async () => {
  const f = fixture()
  expect(f.database.listAccountPoolAssignments()).toEqual([])
  const prepared = await f.service.prepareAccountAcquisition(f.read())
  expect(prepared.record.accountPool?.accountId).toBe('a')
  expect(prepared.record.accountHome).toEqual({
    variable: 'CODEX_HOME',
    path: '/synthetic/pool-home'
  })
  expect(f.database.listAccountPoolAssignments()).toHaveLength(1)
  prepared.preSpawnFailed?.()
  expect(f.database.listAccountPoolAssignments()).toEqual([])
})
it('releases only the proved exact startup generation', async () => {
  const f = fixture()
  await f.service.prepareAccountAcquisition(f.read())
  f.service.accountAcquisitionExited({
    sessionId: f.read().sessionId,
    fence: f.read().lease.runtimeFence,
    generation: null,
    spawnToken: null
  })
  expect(f.database.listAccountPoolAssignments()).toHaveLength(1)
  f.service.accountAcquisitionExited({
    sessionId: f.read().sessionId,
    fence: f.read().lease.runtimeFence,
    generation: 'generation-a',
    spawnToken: 'generation-a'
  })
  expect(f.database.listAccountPoolAssignments()).toEqual([])
})
it('refuses a changed account home on a previously enrolled chat and frees the failed reservation', async () => {
  const f = fixture()
  const first = await f.service.prepareAccountAcquisition(f.read())
  first.preSpawnFailed?.()
  f.read().lease.reservedSpawnToken = 'generation-b'
  f.read().accountHome = { variable: 'CODEX_HOME', path: '/unexpected' }
  await expect(f.service.prepareAccountAcquisition(f.read())).rejects.toThrow('pin changed')
  expect(f.database.listAccountPoolAssignments()).toEqual([])
})

const boundary: NativeAccountRotationBoundary = {
  lastCompletedTurn: { id: 'turn-a', outcome: 'success' },
  childrenSettled: true,
  canRotate: true
}
async function rotationFixture(mode: 'after-turn' | 'on-limit' = 'after-turn') {
  const f = fixture()
  const first = await f.service.prepareAccountAcquisition(f.read())
  first.preSpawnFailed?.()
  f.policy.rotation = mode
  f.policy.members.push({ ...f.policy.members[0], accountId: 'b' })
  f.read().lease.runtimeFence++
  f.read().lease.reservedSpawnToken = 'generation-b'
  f.read().providerHandleChain = [
    {
      linkId: 'link-a',
      handle: codexProviderHandle('thread-a'),
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1
    }
  ]
  return f
}
it('rotates after a completed turn without changing its provider conversation identity', async () => {
  const f = await rotationFixture()
  const oldChain = structuredClone(f.read().providerHandleChain)
  const next = await f.service.prepareAccountAcquisition(f.read(), boundary)
  expect(next.record.accountPool?.accountId).toBe('b')
  expect(next.record.providerHandleChain).toEqual(oldChain)
  expect(mocks.copy).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceHome: '/synthetic/pool-home',
      targetHome: '/synthetic/pool-home-b',
      providerSession: expect.objectContaining({ id: 'thread-a' })
    })
  )
})
it('on-limit preserves a usable account and rotates an exhausted account', async () => {
  const f = await rotationFixture('on-limit')
  const unchanged = await f.service.prepareAccountAcquisition(f.read(), boundary)
  expect(unchanged.record.accountPool?.accountId).toBe('a')
  unchanged.preSpawnFailed?.()
  f.read().lease.reservedSpawnToken = 'generation-c'
  mocks.quota = 'exhausted'
  expect(
    (await f.service.prepareAccountAcquisition(f.read(), boundary)).record.accountPool?.accountId
  ).toBe('b')
})
it('does not rotate with unresolved child work', async () => {
  const f = await rotationFixture()
  const next = await f.service.prepareAccountAcquisition(f.read(), {
    ...boundary,
    childrenSettled: false
  })
  expect(next.record.accountPool?.accountId).toBe('a')
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('rejects policy changes while history materialization awaits', async () => {
  const f = await rotationFixture()
  mocks.copy.mockImplementation(async () => {
    f.policy.revision++
    return {}
  })
  await expect(f.service.prepareAccountAcquisition(f.read(), boundary)).rejects.toThrow(
    'pool changed'
  )
  expect(f.read().accountPool?.accountId).toBe('a')
  expect(f.database.listAccountPoolAssignments()).toEqual([])
})
it('rejects a replaced startup lease after history materialization', async () => {
  const f = await rotationFixture()
  mocks.copy.mockImplementation(async () => {
    f.read().lease.runtimeFence++
    return {}
  })
  await expect(f.service.prepareAccountAcquisition(f.read(), boundary)).rejects.toThrow(
    'startup reservation'
  )
  expect(f.read().accountPool?.accountId).toBe('a')
})
it('preserves the old account when history migration fails', async () => {
  const f = await rotationFixture()
  mocks.copy.mockRejectedValue(new Error('history refused'))
  await expect(f.service.prepareAccountAcquisition(f.read(), boundary)).rejects.toThrow(
    'history refused'
  )
  expect(f.read().accountPool?.accountId).toBe('a')
  expect(f.database.listAccountPoolAssignments()).toEqual([])
})
it('keeps a healthy account when the alternative is unavailable', async () => {
  const f = await rotationFixture()
  mocks.unavailable = true
  expect(f.service.shouldRestForAccountRotation(f.read(), boundary)).toBe(false)
  expect(
    (await f.service.prepareAccountAcquisition(f.read(), boundary)).record.accountPool?.accountId
  ).toBe('a')
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('persists the consumed turn so a restart or failed launch cannot rotate it twice', async () => {
  const f = await rotationFixture()
  const rotated = await f.service.prepareAccountAcquisition(f.read(), boundary)
  expect(rotated.record.accountPool?.lastRotatedTurn).toBe('turn-a')
  rotated.preSpawnFailed?.()
  f.read().lease.reservedSpawnToken = 'generation-c'
  expect(f.service.shouldRestForAccountRotation(f.read(), boundary)).toBe(false)
  const repeated = await f.service.prepareAccountAcquisition(f.read(), boundary)
  expect(repeated.record.accountPool?.accountId).toBe('b')
  expect(mocks.copy).toHaveBeenCalledTimes(1)
})
it('does not evict or migrate a healthy native session merely to consume lower priority', async () => {
  const f = await rotationFixture()
  f.policy.members[1].priority = 2
  expect(f.service.shouldRestForAccountRotation(f.read(), boundary)).toBe(false)
  const result = await f.service.prepareAccountAcquisition(f.read(), boundary)
  expect(result.record.accountPool?.accountId).toBe('a')
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('continues a single-account native pool under after-turn rotation', async () => {
  const f = await rotationFixture()
  f.policy.members.splice(1)
  expect(f.service.shouldRestForAccountRotation(f.read(), boundary)).toBe(false)
  expect(
    (await f.service.prepareAccountAcquisition(f.read(), boundary)).record.accountPool?.accountId
  ).toBe('a')
  expect(mocks.copy).not.toHaveBeenCalled()
})
