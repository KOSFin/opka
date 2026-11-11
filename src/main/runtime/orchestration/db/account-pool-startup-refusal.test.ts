import { expect, it } from 'vitest'
import { nativeAccountPoolFenceFixture } from './account-pool-native-fence-fixture'

it('releases only the exact unconsumed pending PTY generation under one transaction', () => {
  const f = nativeAccountPoolFenceFixture()
  const pending = f.store.acquireAccountPoolAssignment({ ...f.args, ownerKey: 'pty:pending' })
  const other = f.store.acquireAccountPoolAssignment({ ...f.args, ownerKey: 'pty:other' })
  f.store.bindAccountPoolAssignmentPty({
    ownerKey: pending.ownerKey,
    ptyId: 'pty',
    incarnationId: 'generation'
  })
  f.store.bindAccountPoolAssignmentPty({
    ownerKey: other.ownerKey,
    ptyId: 'pty',
    incarnationId: 'other-generation'
  })
  const args = {
    provider: 'codex' as const,
    ptyId: 'pty',
    incarnationId: 'generation',
    assertCurrent: () => false
  }
  f.store.releaseUnconsumedNativeCliStartup(args)
  expect(f.store.listAccountPoolAssignments()).toHaveLength(2)
  f.store.releaseUnconsumedNativeCliStartup({ ...args, assertCurrent: () => true })
  f.store.releaseUnconsumedNativeCliStartup({ ...args, assertCurrent: () => true })
  expect(f.store.listAccountPoolAssignments().map((row) => row.ownerKey)).toEqual([other.ownerKey])
})

it('retains a consumed replacement claim and never creates a reservation for source refusal', () => {
  const f = nativeAccountPoolFenceFixture()
  const args = {
    provider: 'codex' as const,
    ptyId: 'pty',
    incarnationId: 'generation',
    assertCurrent: () => true
  }
  f.store.releaseUnconsumedNativeCliStartup(args)
  expect(f.store.listAccountPoolAssignments()).toEqual([])
  const pending = f.store.acquireAccountPoolAssignment({ ...f.args, ownerKey: 'pty:pending' })
  f.store.bindAccountPoolAssignmentPty({
    ownerKey: pending.ownerKey,
    ptyId: 'pty',
    incarnationId: 'generation'
  })
  f.store.acquireAccountPoolAssignment({
    ...f.args,
    ownerKey: 'native:replacement',
    replacesOwnerKey: pending.ownerKey
  })
  f.store.releaseUnconsumedNativeCliStartup(args)
  expect(f.store.listAccountPoolAssignments().map((row) => row.ownerKey)).toContain(
    pending.ownerKey
  )
})
