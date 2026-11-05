import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { reserveNativeCliStdioLease } from './native-cli-stdio-lease'
import {
  readNativeCliStdioObservationOwner,
  readNativeCliStdioOwner,
  stageNativeCliStdioOwner
} from './native-cli-stdio-owner'

const leases: Awaited<ReturnType<typeof reserveNativeCliStdioLease>>[] = []
const roots: string[] = []
afterEach(async () => {
  for (const lease of leases.splice(0)) {
    await lease.release('unverifiable')
  }
  closeTestJournalHostDatabases()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
  vi.useRealTimers()
})
async function fixture(clear = true, readReferences?: () => 'clear' | 'present') {
  const root = await mkdtemp(join(tmpdir(), 'opka-stdio-lease-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
  const runtime = {
    openAgentSessionRecordStore: async () => store,
    getNativeCliAgentSessionClaimKeyId: () => 'real-host-test-key-id',
    getRuntimeId: () => 'test-host-runtime'
  }
  const launchId = randomUUID()
  const slot = stageNativeCliStdioOwner(runtime, launchId)
  const lease = await reserveNativeCliStdioLease(runtime, launchId, root, join(root, 'home'), () =>
    readReferences ? readReferences() : clear ? 'clear' : 'present'
  )
  leases.push(lease)
  return { lease, store, runtime, slot, launchId }
}
it('uses a valid native lease operation and retires only its proven-ended operational record', async () => {
  const f = await fixture()
  expect(f.store.getRecord(f.lease.sessionId)?.lease).toMatchObject({
    claimStatus: 'reserved',
    ownerProcess: null
  })
  const owner = await f.lease.bind(1234, 50, async () => true)
  f.slot.bind(owner, f.store, f.lease.isCurrent)
  expect(readNativeCliStdioOwner(f.runtime, f.launchId)).toEqual(owner)
  expect(f.store.getSessionTabId(owner.sessionId)).toBeNull()
  f.slot.retire()
  await f.lease.release('pid-absent')
  expect(f.store.getRecord(owner.sessionId)).toBeNull()
  expect(f.store.listOperationRows()).toHaveLength(1)
})
it('retains a useful externally referenced record and reports absence instead of an invented exit', async () => {
  const f = await fixture(false)
  await f.lease.bind(1234, 50, async () => true)
  await f.lease.release('pid-absent')
  expect(f.store.getRecord(f.lease.sessionId)?.lease).toMatchObject({
    claimStatus: 'released',
    deathEvidence: { kind: 'pid-absent' }
  })
})
it('retries guarded record retirement after a reference read fails without re-evicting its released owner', async () => {
  const references = vi.fn<() => 'clear' | 'present'>(() => 'clear')
  const f = await fixture(true, references)
  await f.lease.bind(1234, 50, async () => true)
  references.mockImplementationOnce(() => {
    throw new Error('synthetic reference read failure')
  })
  await expect(f.lease.release('pid-absent')).rejects.toThrow('synthetic reference read failure')
  const fence = f.store.getRecord(f.lease.sessionId)?.lease.runtimeFence
  expect(f.store.getRecord(f.lease.sessionId)?.lease.claimStatus).toBe('released')
  await f.lease.release('pid-absent')
  expect(f.store.getRecord(f.lease.sessionId)).toBeNull()
  expect(fence).toBeGreaterThan(0)
  await expect(f.lease.release('pid-absent')).resolves.toBeUndefined()
})
it('keeps an unverifiable live writer reserved and stops renewal without declaring death', async () => {
  const f = await fixture()
  await f.lease.bind(1234, 50, async () => true)
  await f.lease.release('unverifiable')
  expect(f.store.getRecord(f.lease.sessionId)?.lease).toMatchObject({
    claimStatus: 'live',
    deathEvidence: null
  })
})
it('requires renewed native process proof for switching but keeps authenticated observation separate', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  const prove = vi.fn(async () => true)
  const owner = await f.lease.bind(1234, 50, prove)
  f.slot.bind(owner, f.store, f.lease.isCurrent)
  prove.mockResolvedValue(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(prove).toHaveBeenCalledTimes(1)
  expect(readNativeCliStdioOwner(f.runtime, f.launchId)).toBeNull()
  expect(readNativeCliStdioObservationOwner(f.runtime, f.launchId)).toEqual(owner)
  prove.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(readNativeCliStdioOwner(f.runtime, f.launchId)).toEqual(owner)
  f.slot.retire()
})
