import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { AccountPoolAdmission } from './account-pool-admission'
import { readAccountAssignments } from './account-pool-admission'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())
function fixture(strategy: 'sequential' | 'balanced' | 'manual' = 'sequential') {
  const store = new OrchestrationDb(':memory:')
  db = store
  const admission: AccountPoolAdmission = {
    policy: {
      id: 'pool',
      provider: 'codex',
      revision: 1,
      strategy,
      applyToNewWork: false,
      rotation: 'off',
      unknownQuota: 'exclude',
      allowReserve: false,
      members: ['a', 'b'].map((accountId) => ({
        accountId,
        priority: 1,
        weight: 1,
        maxConcurrent: 2,
        state: 'enabled',
        role: 'primary'
      }))
    },
    candidates: ['a', 'b'].map((accountId) => ({
      accountId,
      quotaIdentity: accountId,
      auth: 'ready',
      quota: 'available',
      usedPercent: 20
    }))
  }
  const start = () =>
    store.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 2,
      taskSpec: 'Synthetic pool worker',
      taskRunId: 'run_legacy_local',
      startOptions: {},
      accountPoolAdmission: admission
    })
  return { store, admission, start }
}
it('sequential fills a priority tier and persists immutable identity and policy revision', () => {
  const { store, start } = fixture()
  start()
  start()
  start()
  expect(
    readAccountAssignments(store.db)
      .map((entry) => entry.accountId)
      .sort()
  ).toEqual(['a', 'a', 'b'])
  const row = store.db
    .prepare(
      "SELECT start_options FROM worker_dispatches WHERE json_extract(start_options, '$.account.id')='a' LIMIT 1"
    )
    .get()
  expect(JSON.parse(String(row?.start_options))).toMatchObject({
    accountPool: { id: 'pool', revision: 1 },
    account: { id: 'a' }
  })
})
it('balanced uses slots and weights within a tier while priority remains strongest', () => {
  const { store, admission, start } = fixture('balanced')
  start()
  start()
  expect(
    readAccountAssignments(store.db)
      .map((entry) => entry.accountId)
      .sort()
  ).toEqual(['a', 'b'])
  admission.policy.members[1].priority = 2
  const third = start()
  expect(JSON.parse(third.worker.start_options).account.id).toBe('a')
})
it.each(['start_unknown', 'stop_unknown', 'starting', 'stopping', 'ready'])(
  'retains %s reservations and rolls back rejected dispatch/task',
  (state) => {
    const { store, admission, start } = fixture()
    admission.policy.members = [admission.policy.members[0]]
    admission.policy.members[0].maxConcurrent = 1
    const accepted = start()
    store.db
      .prepare('UPDATE worker_dispatches SET state=? WHERE dispatch_id=?')
      .run(state, accepted.dispatch.id)
    expect(() => start()).toThrow(/No eligible account/)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n).toBe(1)
    store.db
      .prepare("UPDATE worker_dispatches SET state='failed' WHERE dispatch_id=?")
      .run(accepted.dispatch.id)
    expect(start().worker.state).toBe('starting')
  }
)
it.each(['disabled', 'draining'] as const)('excludes %s membership', (state) => {
  const { store, admission, start } = fixture()
  admission.policy.members[0].state = state
  start()
  expect(readAccountAssignments(store.db)[0].accountId).toBe('b')
})
it('excludes unavailable auth, unknown/exhausted quota, cooldown and reserve unless permitted', () => {
  const { admission, start } = fixture()
  admission.candidates[0].quota = 'unknown'
  admission.policy.members[1].role = 'reserve'
  expect(() => start()).toThrow(/No eligible account/)
  admission.policy.allowReserve = true
  admission.policy.members[1].cooldownUntil = Date.now() + 60_000
  expect(() => start()).toThrow(/No eligible account/)
  admission.policy.unknownQuota = 'allow'
  admission.candidates[0].auth = 'unavailable'
  expect(() => start()).toThrow(/No eligible account/)
  admission.candidates[0].auth = 'ready'
  admission.candidates[0].quota = 'exhausted'
  expect(() => start()).toThrow(/No eligible account/)
  admission.candidates[0].quota = 'unknown'
  expect(start().worker.state).toBe('starting')
})
it('shares slots for duplicate quota identity across registered profiles', () => {
  const { admission, start } = fixture()
  admission.policy.members.forEach((member) => {
    member.maxConcurrent = 1
  })
  admission.candidates.forEach((candidate) => {
    candidate.quotaIdentity = 'same'
  })
  start()
  expect(() => start()).toThrow(/No eligible account/)
})
it('manual pool requires explicit selection', () => {
  const { start } = fixture('manual')
  expect(() => start()).toThrow(/Choose a fixed account/)
})

it('keeps a sequential preferred account only in the highest eligible tier', () => {
  const { admission, start } = fixture()
  admission.preferredAccountId = 'b'
  expect(JSON.parse(start().worker.start_options).account.id).toBe('b')
  admission.policy.members[1].priority = 2
  expect(JSON.parse(start().worker.start_options).account.id).toBe('a')
})
it('does not let a preferred reserve displace a primary or override balancing', () => {
  const { admission, start } = fixture('balanced')
  admission.preferredAccountId = 'b'
  expect(JSON.parse(start().worker.start_options).account.id).toBe('a')
  admission.policy.strategy = 'sequential'
  admission.policy.allowReserve = true
  admission.policy.members[1].role = 'reserve'
  expect(JSON.parse(start().worker.start_options).account.id).toBe('a')
})
