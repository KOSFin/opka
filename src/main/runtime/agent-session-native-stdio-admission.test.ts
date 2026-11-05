import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import { NATIVE_STDIO_RETAINED_RECORD_LIMIT } from './agent-session-native-stdio-admission'

const roots: string[] = []
const NOW = 1_800_000_000_000
afterEach(async () => {
  closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function request(sessionId = `native_stdio_${randomUUID()}`): AgentSessionReserveRequest {
  return {
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/synthetic/owned-codex' },
    expectedFence: null,
    spawnToken: 'synthetic-unused-reservation',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'native-stdio',
      operationId: `${NOW}-${randomUUID().replaceAll('-', '')}`,
      fingerprint: 'a'.repeat(64)
    },
    now: NOW
  }
}
async function fixture(readable: number, unreadable = 0, generic = 0) {
  const root = await mkdtemp(join(tmpdir(), 'opka-stdio-cap-'))
  roots.push(root)
  const record = (sessionId: string) =>
    agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  await seedTestAgentSessionRecordStore(root, {
    records: [
      ...Array.from({ length: readable }, (_, index) => record(`native_stdio_retained-${index}`)),
      ...Array.from({ length: generic }, (_, index) => record(`chat-${index}`))
    ]
  })
  await editPersistedTestAgentSessionStore(root, (state) => {
    for (let index = 0; index < unreadable; index++) {
      state.unusableRecords[`native_stdio_unknown-${index}`] = {
        reason: 'newer or malformed internal record',
        raw: { unknown: true }
      }
    }
  })
  const store = await openTestAgentSessionRecordStore(root)
  return { root, store }
}
it('admits record 512 and atomically refuses 513 without losing retained rows or adding an operation', async () => {
  const { root, store } = await fixture(NATIVE_STDIO_RETAINED_RECORD_LIMIT - 1)
  await store.reserveOwner(request())
  const before = await readPersistedTestAgentSessionStore(root)
  const refused = request()
  await expect(store.reserveOwner(refused)).rejects.toBeInstanceOf(NativeCliControlError)
  await expect(store.reserveOwner(refused)).rejects.toMatchObject({ reason: 'retention_full' })
  expect(await readPersistedTestAgentSessionStore(root)).toEqual(before)
  expect(store.getRecord(refused.sessionId)).toBeNull()
  const reopened = await openTestAgentSessionRecordStore(root)
  await expect(reopened.reserveOwner(request())).rejects.toMatchObject({ reason: 'retention_full' })
})
it('counts malformed and unreadable internal prefix rows while leaving unrelated chat admission unchanged', async () => {
  const { store } = await fixture(1, NATIVE_STDIO_RETAINED_RECORD_LIMIT - 1, 10)
  await expect(store.reserveOwner(request())).rejects.toMatchObject({ reason: 'retention_full' })
  const chat = request('ordinary-chat')
  chat.operation.callerKey = 'ordinary-client'
  expect((await store.reserveOwner(chat)).disposition).toBe('created')
})
it('does not count generic chat rows against internal capacity', async () => {
  const { store } = await fixture(0, 0, NATIVE_STDIO_RETAINED_RECORD_LIMIT)
  expect((await store.reserveOwner(request())).disposition).toBe('created')
})
it('permits exact operation replay and a new reservation of the same internal row at capacity', async () => {
  const { store } = await fixture(NATIVE_STDIO_RETAINED_RECORD_LIMIT - 1)
  const first = request()
  await store.reserveOwner(first)
  expect((await store.reserveOwner(first)).disposition).toBe('replayed')
  const again = request(first.sessionId)
  again.expectedFence = 1
  const reacquired = await store.reserveOwner(again)
  expect(reacquired.disposition).toBe('reserved')
  expect(reacquired.record.lease.runtimeFence).toBe(2)
})
it('serializes two admissions competing for the final internal record slot', async () => {
  const { root, store } = await fixture(NATIVE_STDIO_RETAINED_RECORD_LIMIT - 1)
  const outcomes = await Promise.allSettled([
    store.reserveOwner(request()),
    store.reserveOwner(request())
  ])
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
  expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
    reason: 'retention_full'
  })
  expect(Object.keys((await readPersistedTestAgentSessionStore(root)).records)).toHaveLength(
    NATIVE_STDIO_RETAINED_RECORD_LIMIT
  )
})
