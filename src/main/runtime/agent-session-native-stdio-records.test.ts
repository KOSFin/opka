import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  agentSessionOperationKey,
  agentSessionOperationExpiry
} from '../../shared/agent-session-operation-ledger'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore,
  editPersistedTestAgentSessionStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'

const roots: string[] = []
afterEach(async () => {
  closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function openReconciled(root: string) {
  const store = await openTestAgentSessionRecordStore(root)
  await store.reconcileOnRestart({
    probe: async () => ({ outcome: 'indeterminate', reason: 'released fixture has no owner' }),
    now: Date.now()
  })
  return store
}
async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'opka-stdio-retire-'))
  roots.push(root)
  const now = Date.now(),
    fingerprint = 'a'.repeat(64)
  const rows = Array.from({ length: count }, (_, index) => {
    const sessionId = `native_stdio_${randomUUID()}`
    const operationId = `${now + index}-${randomUUID().replaceAll('-', '')}`
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId,
        runtimeFence: 8,
        claimStatus: 'released',
        ownerProcess: null,
        reservedSpawnToken: null,
        unreconciled: false,
        deathEvidence: {
          kind: 'exit-observed',
          detail: 'own process exit',
          ownerFence: 7,
          observedAt: now
        }
      })
    )
    record.location = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
      workspaceKind: 'folder'
    }
    return { record, operationId, fingerprint }
  })
  await seedTestAgentSessionRecordStore(root, { records: rows.map((row) => row.record) })
  await editPersistedTestAgentSessionStore(root, (state) => {
    for (const row of rows) {
      state.operations[agentSessionOperationKey('native-stdio', row.operationId)] = {
        callerKey: 'native-stdio',
        operationId: row.operationId,
        fingerprint,
        operationTimestamp: Number(row.operationId.slice(0, 13)),
        recordedAt: now,
        expiresAt: agentSessionOperationExpiry(Number(row.operationId.slice(0, 13)), now),
        outcome: { status: 'succeeded', sessionId: row.record.sessionId }
      }
    }
  })
  const store = await openReconciled(root)
  const db = openTestJournalHostDatabase(root).db
  const args = {
    sessionId: rows[0].record.sessionId,
    releasedFence: 8,
    operationId: rows[0].operationId,
    fingerprint,
    proof: 'exited' as const,
    readExternalReferences: () => 'clear' as const
  }
  return { root, rows, store, db, args }
}
it('retires only disposable records across1000invocations while keeping replay tombstones', async () => {
  const f = await fixture(1000)
  for (const row of f.rows) {
    expect(
      await f.store.nativeStdioRecords.retire({
        ...f.args,
        sessionId: row.record.sessionId,
        operationId: row.operationId
      })
    ).toBe(true)
  }
  expect(f.store.listRecords()).toHaveLength(0)
  const persisted = await readPersistedTestAgentSessionStore(f.root)
  expect(Object.keys(persisted.records)).toHaveLength(0)
  expect(Object.keys(persisted.operations)).toHaveLength(1000)
  expect((await openReconciled(f.root)).listRecords()).toHaveLength(0)
}, 15000)
it('rejects stale fences and unknown external ownership without deleting anything', async () => {
  const f = await fixture()
  expect(await f.store.nativeStdioRecords.retire({ ...f.args, releasedFence: 7 })).toBe(false)
  expect(
    await f.store.nativeStdioRecords.retire({
      ...f.args,
      readExternalReferences: () => 'unverifiable'
    })
  ).toBe(false)
  expect(
    await f.store.nativeStdioRecords.retire({ ...f.args, readExternalReferences: () => 'present' })
  ).toBe(false)
  expect(f.store.getRecord(f.args.sessionId)).not.toBeNull()
})
it('retains real journal epochs and unknown additive schema', async () => {
  const f = await fixture()
  f.db
    .prepare('INSERT INTO journal_sessions(session_id,workspace_id,epoch) VALUES(?,?,?)')
    .run(f.args.sessionId, 'own', 'epoch')
  expect(await f.store.nativeStdioRecords.retire(f.args)).toBe(false)
  expect(f.store.getRecord(f.args.sessionId)).not.toBeNull()
  f.db.prepare('DELETE FROM journal_sessions WHERE session_id=?').run(f.args.sessionId)
  f.db.exec('CREATE TABLE future_references(session_id TEXT)')
  expect(await f.store.nativeStdioRecords.retire(f.args)).toBe(false)
})
it('retains UI references and pending/unknown or additional operations', async () => {
  const f = await fixture()
  await f.store.setSessionTabVisibility(f.args.sessionId, true)
  expect(await f.store.nativeStdioRecords.retire(f.args)).toBe(false)
})
it('checks late references inside the same journal transaction before deleting a record', async () => {
  const f = await fixture()
  expect(
    await f.store.nativeStdioRecords.retire({
      ...f.args,
      readExternalReferences: () => {
        f.db
          .prepare('INSERT INTO journal_sessions(session_id,workspace_id,epoch) VALUES(?,?,?)')
          .run(f.args.sessionId, 'late', 'epoch')
        return 'clear'
      }
    })
  ).toBe(false)
  expect(f.store.getRecord(f.args.sessionId)).not.toBeNull()
})
it('retains additional succeeded, pending and unknown operation references', async () => {
  for (const status of ['succeeded', 'pending', 'unknown'] as const) {
    const f = await fixture()
    await editPersistedTestAgentSessionStore(f.root, (state) => {
      const own = Object.values(state.operations)[0]
      const row = { ...own, callerKey: 'other-client' }
      row.outcome = status === 'succeeded' ? { status, sessionId: f.args.sessionId } : { status }
      state.operations[agentSessionOperationKey(row.callerKey, row.operationId)] = row
    })
    const store = await openReconciled(f.root)
    expect(await store.nativeStdioRecords.retire(f.args)).toBe(false)
    expect(store.getRecord(f.args.sessionId)).not.toBeNull()
  }
})
it('keeps command receipts that would otherwise be cascaded away', async () => {
  const f = await fixture()
  f.db.exec(
    'CREATE TABLE IF NOT EXISTS agent_session_command_receipts(operation_id TEXT,session_id TEXT,caller_key TEXT,method TEXT,fingerprint TEXT,status TEXT,result_json TEXT,rejection_json TEXT,accepted_at INTEGER)'
  )
  f.db
    .prepare(
      'INSERT INTO agent_session_command_receipts(operation_id,session_id,caller_key,method,fingerprint,status,accepted_at) VALUES(?,?,?,?,?,?,?)'
    )
    .run('own-receipt', f.args.sessionId, 'user', 'send', 'hash', 'pending', Date.now())
  expect(await f.store.nativeStdioRecords.retire(f.args)).toBe(false)
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM agent_session_command_receipts').get()
  ).toEqual({ count: 1 })
})
it('retains an operational row when unknown triggers could affect references', async () => {
  const f = await fixture()
  f.db.exec(
    "CREATE TRIGGER retain_owned_record BEFORE DELETE ON agent_session_records BEGIN SELECT RAISE(ABORT,'keep record'); END"
  )
  expect(await f.store.nativeStdioRecords.retire(f.args)).toBe(false)
  expect(f.store.getRecord(f.args.sessionId)).not.toBeNull()
  expect((await readPersistedTestAgentSessionStore(f.root)).records[f.args.sessionId]).toBeDefined()
})

it('accepts pid-absent evidence without misreporting a native exit', async () => {
  const f = await fixture()
  await editPersistedTestAgentSessionStore(f.root, (state) => {
    const record = state.records[f.args.sessionId]
    record.lease.deathEvidence = {
      kind: 'pid-absent',
      detail: 'verified process group absent',
      ownerFence: 7,
      observedAt: Date.now()
    }
  })
  const store = await openReconciled(f.root)
  expect(await store.nativeStdioRecords.retire({ ...f.args, proof: 'exited' })).toBe(false)
  expect(await store.nativeStdioRecords.retire({ ...f.args, proof: 'pid-absent' })).toBe(true)
})

it('keeps old reservation replay fenced after the operational record retires', async () => {
  const f = await fixture()
  expect(await f.store.nativeStdioRecords.retire(f.args)).toBe(true)
  const row = f.rows[0]
  await expect(
    f.store.reserveOwner({
      sessionId: f.args.sessionId,
      location: row.record.location,
      provider: 'claude',
      accountHome: row.record.accountHome,
      expectedFence: null,
      spawnToken: randomUUID(),
      claimKeyId: 'own-key',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'native-stdio',
        operationId: f.args.operationId,
        fingerprint: f.args.fingerprint
      },
      now: Date.now()
    })
  ).rejects.toMatchObject({
    refusal: { code: 'agent_session_ownership_unknown', details: { reason: 'recordMissing' } }
  })
  expect(f.store.getRecord(f.args.sessionId)).toBeNull()
})
it('preserves attachment claims as legitimate session references', async () => {
  const f = await fixture()
  f.db
    .prepare(
      'INSERT INTO agent_session_attachment_claims(upload_id,session_id,claimed_at) VALUES(?,?,?)'
    )
    .run('own-upload', f.args.sessionId, Date.now())
  expect(await f.store.nativeStdioRecords.retire(f.args)).toBe(false)
  expect(
    f.db.prepare('SELECT COUNT(*) AS count FROM agent_session_attachment_claims').get()
  ).toEqual({ count: 1 })
})
