import { afterEach, expect, it } from 'vitest'
import type { AccountPoolCandidate, AccountPoolPolicy } from '../../shared/account-pool-policy'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { createCodexPoolTurnSession, type CodexPoolSelectionState } from './codex-pool-turn-session'

const stores: OrchestrationDb[] = []
afterEach(() => {
  for (const db of stores.splice(0)) {
    db.close()
  }
})
function fixture() {
  const db = new OrchestrationDb(':memory:')
  stores.push(db)
  const policy: AccountPoolPolicy = {
    id: 'codex-only',
    provider: 'codex',
    revision: 1,
    strategy: 'sequential',
    applyToNewWork: true,
    rotation: 'on-limit',
    unknownQuota: 'exclude',
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
  const candidates: AccountPoolCandidate[] = ['a', 'b'].map((accountId) => ({
    accountId,
    quotaIdentity: accountId,
    auth: 'ready',
    quota: 'available',
    usedPercent: 10
  }))
  const state: CodexPoolSelectionState = {
    policy,
    candidates,
    manualAccountId: 'manual'
  }
  const boundary = { safe: true, safeChildren: true, safeRetained: true }
  const create = () =>
    createCodexPoolTurnSession({
      db,
      readState: () => state,
      canSwitch: () => boundary.safe,
      canReplaceRejectedRequest: () => boundary.safeChildren,
      areRetainedTurnsSettled: () => boundary.safeRetained,
      ownerPrefix: 'synthetic'
    })
  return { db, state, policy, candidates, boundary, session: create(), create }
}
const root = (turnId: string) => ({ threadId: 'native-thread', turnId })

it('does not let native title requests steal the ROOT or consume its Stop permit', () => {
  const { db, state, policy } = fixture()
  const roots: (string | null)[] = []
  let consumed = 0
  const session = createCodexPoolTurnSession({
    db,
    readState: () => state,
    ownerPrefix: 'title-test',
    canSwitch: () => true,
    onRootThreadBound: (id) => roots.push(id),
    onBoundaryAccepted: () => {
      consumed++
    }
  })
  session.begin({ threadId: 'title-first', turnId: 'title-0', auxiliary: true }).finish()
  expect(roots).toEqual([])
  session.begin(root('0')).finish()
  expect(roots).toEqual(['native-thread'])
  policy.revision++
  policy.members[0].state = 'disabled'
  const title = session.begin({ threadId: 'title-after', turnId: 'title-1', auxiliary: true })
  expect(title.accountId).toBe('a')
  expect(roots).toEqual(['native-thread'])
  expect(consumed).toBe(0)
  title.finish()
  expect(session.begin(root('1')).accountId).toBe('b')
  expect(consumed).toBe(1)
})

it('refuses stale child requests after a turn change instead of sending them under a new account', () => {
  const { session, policy } = fixture()
  session.begin(root('0')).finish()
  policy.revision++
  policy.members[0].state = 'disabled'
  session.begin(root('1')).finish()
  expect(session.snapshot().accountId).toBe('b')
  for (const identity of [
    { threadId: 'old-child', turnId: 'child', parentThreadId: 'native-thread', rootTurnId: '0' },
    { threadId: 'unknown-child', turnId: 'child', parentThreadId: 'native-thread' }
  ]) {
    expect(() => session.begin(identity)).toThrow('cannot bind this child request')
  }
  expect(session.snapshot().activeRequests).toBe(0)
  const current = session.begin({
    threadId: 'child',
    turnId: 'child',
    parentThreadId: 'native-thread',
    rootTurnId: '1'
  })
  expect(current.accountId).toBe('b')
  current.finish()
})

it('applies saved priorities at the next native turn, never between tool round trips', () => {
  const { session, policy, db } = fixture()
  const first = session.begin(root('0'))
  expect(first.accountId).toBe('a')
  first.finish()
  policy.revision = 2
  policy.members[0].priority = 2
  const toolRoundTrip = session.begin(root('0'))
  expect(toolRoundTrip).toMatchObject({ accountId: 'a', policyRevision: 1 })
  toolRoundTrip.finish()
  expect(session.snapshot()).toMatchObject({ appliedRevision: 1, configuredRevision: 2 })
  const next = session.begin(root('1'))
  expect(next).toMatchObject({ accountId: 'b', policyRevision: 2 })
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  next.finish()
})

it('keeps native child threads on their parent turn account, including incomplete child metadata', () => {
  const { session, policy } = fixture()
  session.begin(root('0')).finish()
  policy.revision++
  policy.members[0].state = 'disabled'
  for (const identity of [
    { threadId: 'child', turnId: 'child-turn', parentThreadId: 'native-thread', rootTurnId: '0' },
    { threadId: 'nested-child', turnId: 'other', parentThreadId: 'child' }
  ]) {
    const request = session.begin(identity)
    expect(request.accountId).toBe('a')
    request.finish()
  }
  const next = session.begin(root('1'))
  expect(next.accountId).toBe('b')
  next.finish()
})

it('continues on the pinned account while an earlier request is still active', () => {
  const { session, policy } = fixture()
  const active = session.begin(root('0'))
  policy.revision++
  policy.members[0].state = 'disabled'
  const pending = session.begin(root('1'))
  expect(pending.accountId).toBe('a')
  expect(session.snapshot().activeRequests).toBe(2)
  pending.finish()
  active.finish()
  const next = session.begin(root('2'))
  expect(next.accountId).toBe('b')
  next.finish()
})

it('does not infer child or tool completion from a different native turn id', () => {
  const { session, policy, boundary } = fixture()
  session.begin(root('0')).finish()
  policy.revision++
  policy.members[0].state = 'disabled'
  boundary.safe = false
  session.begin(root('1')).finish()
  expect(session.snapshot()).toMatchObject({
    accountId: 'a',
    appliedRevision: 1,
    switchReady: false
  })
  boundary.safe = true
  const sameTurn = session.begin(root('1'))
  expect(sameTurn.accountId).toBe('a')
  sameTurn.finish()
  const next = session.begin(root('2'))
  expect(next.accountId).toBe('b')
  next.finish()
})

it('missing initial metadata cannot be repaired by guessing a safe later boundary', () => {
  const { session, policy } = fixture()
  session.begin().finish()
  policy.revision++
  policy.members[0].state = 'disabled'
  const later = session.begin(root('new'))
  expect(later.accountId).toBe('a')
  expect(session.snapshot().boundaryVerified).toBe(false)
  expect(session.snapshot().switchReady).toBe(false)
  later.finish()
})

it('does not mistake an initial internal child for a root user-turn boundary', () => {
  const { session, policy } = fixture()
  session.begin({ threadId: 'child', turnId: '0', parentThreadId: 'unknown-root' }).finish()
  policy.revision++
  const next = session.begin(root('1'))
  expect(next.policyRevision).toBe(1)
  expect(session.snapshot().boundaryVerified).toBe(false)
  next.finish()
})

it('on-limit keeps a healthy account then uses another eligible account when exhausted', () => {
  const { session, candidates } = fixture()
  session.begin(root('0')).finish()
  const same = session.begin(root('1'))
  expect(same.accountId).toBe('a')
  same.finish()
  candidates[0].quota = 'exhausted'
  const next = session.begin(root('2'))
  expect(next.accountId).toBe('b')
  next.finish()
})

it('rolls back release if reconfiguration cannot acquire any eligible account', () => {
  const { session, policy, candidates, db } = fixture()
  session.begin(root('0')).finish()
  const original = db.listAccountPoolAssignments()[0]
  policy.revision++
  for (const candidate of candidates) {
    candidate.auth = 'unavailable'
  }
  expect(() => session.begin(root('1'))).toThrow(/No eligible account/)
  expect(db.listAccountPoolAssignments()).toEqual([original])
  expect(session.snapshot()).toMatchObject({
    accountId: 'a',
    appliedRevision: 1,
    activeRequests: 0
  })
  candidates[1].auth = 'ready'
  session.begin(root('1')).finish()
  expect(db.listAccountPoolAssignments()[0].accountId).toBe('b')
})

it('releases its own slot within the same transaction before balanced selection', () => {
  const { create, session, policy, db } = fixture()
  policy.strategy = 'balanced'
  policy.rotation = 'after-turn'
  const other = create()
  session.begin(root('0')).finish()
  other.begin({ threadId: 'other-thread', turnId: '0' }).finish()
  const request = session.begin(root('1'))
  expect(request.accountId).toBe('a')
  expect(db.listAccountPoolAssignments()).toHaveLength(2)
  request.finish()
})

it.each(['disabled', 'manual'] as const)(
  'keeps an open native account when pool is %s, releases its slot and resumes live policy',
  (mode) => {
    const { session, policy, db, create } = fixture()
    session.begin(root('0')).finish()
    if (mode === 'disabled') {
      policy.applyToNewWork = false
    } else {
      policy.strategy = 'manual'
    }
    const next = session.begin(root('1'))
    expect(next).toMatchObject({ accountId: 'a', policyRevision: null, assignmentOwnerKey: null })
    expect(db.listAccountPoolAssignments()).toHaveLength(0)
    next.finish()
    const fresh = create()
    expect(fresh.begin(root('new')).accountId).toBe('manual')
    policy.applyToNewWork = true
    policy.strategy = 'sequential'
    policy.revision++
    policy.members[0].state = 'disabled'
    const resumed = session.begin(root('2'))
    expect(resumed.accountId).toBe('b')
    expect(db.listAccountPoolAssignments()).toHaveLength(1)
    resumed.finish()
  }
)

it('adopts enabled live policy at a safe boundary after starting with an implicit manual default', () => {
  const { session, state, policy } = fixture()
  state.policy = undefined
  session.begin(root('0')).finish()
  expect(session.snapshot().accountId).toBe('manual')
  state.policy = policy
  const next = session.begin(root('1'))
  expect(next.accountId).toBe('a')
  next.finish()
})

it('closing retains slots for active requests, refuses new ones and releases only once finished', () => {
  const { session, db } = fixture()
  const request = session.begin(root('0'))
  session.close('exited')
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  expect(() => session.begin(root('1'))).toThrow(/closed/)
  request.finish()
  request.finish()
  expect(db.listAccountPoolAssignments()).toHaveLength(0)
  expect(session.snapshot().activeRequests).toBe(0)
})

it('closing on lost contact retains the assignment until owner-tree exit is proved', () => {
  const { session, db, boundary } = fixture()
  session.begin(root('0')).finish()
  boundary.safe = false
  session.close()
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  boundary.safe = true
  expect(session.snapshot().switchReady).toBe(false)
  session.close('unverifiable')
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  session.close('exited')
  expect(db.listAccountPoolAssignments()).toHaveLength(0)
})

it('rejects a Claude pool instead of silently mixing provider identities', () => {
  const { policy, session } = fixture()
  policy.provider = 'claude'
  expect(() => session.begin(root('0'))).toThrow(/another provider/)
})

it('replaces only the rejected request transactionally without advancing the native turn', () => {
  const { session, policy, candidates, db, boundary } = fixture()
  const request = session.begin(root('0'))
  boundary.safe = false
  candidates[0].quota = 'exhausted'
  const replacement = session.replaceRejectedRequest({
    policyId: policy.id,
    expectedRevision: 1,
    excludedAccountIds: ['a'],
    excludedQuotaIdentities: ['a']
  })
  expect(replacement).toMatchObject({ accountId: 'b', quotaIdentity: 'b', policyRevision: 1 })
  expect(session.snapshot()).toMatchObject({ activeRequests: 1, accountId: 'b' })
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  request.finish()
  expect(session.begin(root('0')).accountId).toBe('b')
})

it('rolls back unavailable replacement and rejects stale policies, aliases and concurrent HTTP', () => {
  const { session, policy, candidates, db } = fixture()
  const first = session.begin(root('0'))
  const replace = () =>
    session.replaceRejectedRequest({
      policyId: policy.id,
      expectedRevision: 1,
      excludedAccountIds: ['a'],
      excludedQuotaIdentities: ['a']
    })
  const concurrent = session.begin(root('0'))
  expect(replace()).toBeNull()
  concurrent.finish()
  policy.revision++
  expect(replace()).toBeNull()
  policy.revision--
  candidates[1].quotaIdentity = 'a'
  expect(replace()).toBeNull()
  expect(session.snapshot()).toMatchObject({ accountId: 'a', activeRequests: 1 })
  expect(db.listAccountPoolAssignments()[0].ownerKey).toBe(first.assignmentOwnerKey)
  first.finish()
})

it('explicitly revokes a capability after HTTP drains without asserting process exit', () => {
  const { session, db } = fixture()
  const first = session.begin(root('0'))
  session.revoke()
  expect(() => session.begin(root('0'))).toThrow('closed')
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  first.finish()
  first.finish()
  expect(db.listAccountPoolAssignments()).toHaveLength(0)
  expect(session.snapshot().activeRequests).toBe(0)
})

it('transfers an explicitly verified initial lease atomically and preserves it on failed proof', () => {
  const { session: previous, db, state, policy } = fixture()
  const old = previous.begin(root('old'))
  old.finish()
  if (!old.assignmentOwnerKey) {
    throw new Error('Missing pooled fixture owner')
  }
  let verified = false
  const session = createCodexPoolTurnSession({
    db,
    ownerPrefix: 'transferred',
    canSwitch: () => false,
    readState: () => ({
      ...state,
      policy: { ...policy, members: policy.members.filter((member) => member.accountId === 'a') }
    }),
    initialAssignment: {
      ownerKey: old.assignmentOwnerKey,
      assertCurrent: () => {
        if (!verified) {
          throw new Error('stale launch')
        }
      }
    }
  })
  expect(() => session.begin(root('0'))).toThrow('stale launch')
  expect(db.listAccountPoolAssignments()[0].ownerKey).toBe(old.assignmentOwnerKey)
  verified = true
  const current = session.begin(root('0'))
  expect(current.accountId).toBe('a')
  expect(current.assignmentOwnerKey).not.toBe(old.assignmentOwnerKey)
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  current.finish()
})

it('adopts a legitimate new root after selecting with the old safe boundary', () => {
  const { db, state, policy } = fixture()
  const observed: (string | null)[] = []
  const session = createCodexPoolTurnSession({
    db,
    readState: () => state,
    canSwitch: () => true,
    ownerPrefix: 'root-proof',
    onRootThreadBound: (id) => {
      observed.push(id)
    },
    readBoundary: () => ({
      canSwitch: () => observed.at(-1) === 'native-thread',
      onBoundaryAccepted: () => {
        expect(observed.at(-1)).toBe('native-thread')
      }
    })
  })
  session.begin(root('0')).finish()
  policy.revision++
  policy.members[0].state = 'disabled'
  const next = session.begin({ threadId: 'new-native-conversation', turnId: '1' })
  expect(next.accountId).toBe('b')
  expect(observed).toEqual(['native-thread', 'new-native-conversation'])
  next.finish()
  expect(() =>
    session.begin({
      threadId: 'old-child',
      turnId: 'child',
      parentThreadId: 'native-thread',
      rootTurnId: '0'
    })
  ).toThrow('cannot bind')
})

it('keeps unresolved old-root children on their account across new roots, then resumes saved policy', () => {
  const { session, boundary, policy, db } = fixture()
  session.begin(root('0')).finish()
  boundary.safe = false
  boundary.safeRetained = false
  policy.revision++
  policy.members[0].state = 'disabled'
  const next = session.begin({ threadId: 'new-native-conversation', turnId: '1' })
  expect(next.accountId).toBe('a')
  next.finish()
  const oldChild = session.begin({
    threadId: 'old-child',
    turnId: 'child',
    parentThreadId: 'native-thread',
    rootTurnId: '0'
  })
  expect(oldChild.accountId).toBe('a')
  oldChild.finish()
  boundary.safe = true
  const held = session.begin({ threadId: 'new-native-conversation', turnId: '2' })
  expect(held.accountId).toBe('a')
  held.finish()
  boundary.safeRetained = true
  const ready = session.begin({ threadId: 'new-native-conversation', turnId: '3' })
  expect(ready.accountId).toBe('b')
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  ready.finish()
})

it('refuses affinity expansion at its bound while preserving existing roots and their lease', () => {
  const { session, boundary, db } = fixture()
  boundary.safe = false
  boundary.safeRetained = false
  for (let i = 0; i < 64; i++) {
    session.begin({ threadId: `thread-${i}`, turnId: `turn-${i}` }).finish()
  }
  expect(() => session.begin({ threadId: 'over-capacity', turnId: 'overflow' })).toThrow(
    'affinity capacity'
  )
  expect(session.activeRequests).toBe(0)
  expect(db.listAccountPoolAssignments()).toHaveLength(1)
  const old = session.begin({
    threadId: 'child',
    turnId: 'child',
    parentThreadId: 'thread-0',
    rootTurnId: 'turn-0'
  })
  expect(old.accountId).toBe('a')
  old.finish()
})

it.each([undefined, { threadId: 'child', turnId: '0', parentThreadId: 'unseen-root' }])(
  'never repairs missing initial root proof from later metadata (%j)',
  (initial) => {
    const { db, state } = fixture()
    const observed: (string | null)[] = []
    const session = createCodexPoolTurnSession({
      db,
      readState: () => state,
      canSwitch: () => true,
      ownerPrefix: 'no-proof',
      onRootThreadBound: (id) => {
        observed.push(id)
      }
    })
    session.begin(initial).finish()
    session.begin(root('later')).finish()
    expect(observed).toEqual([null])
    expect(session.snapshot().boundaryVerified).toBe(false)
  }
)

it('stops quota replacement while children remain active or their evidence is unavailable', () => {
  const { session, boundary, policy, db } = fixture()
  const first = session.begin(root('0'))
  boundary.safeChildren = false
  expect(
    session.replaceRejectedRequest({
      policyId: policy.id,
      expectedRevision: 1,
      excludedAccountIds: ['a'],
      excludedQuotaIdentities: ['a']
    })
  ).toBeNull()
  expect(db.listAccountPoolAssignments()[0].ownerKey).toBe(first.assignmentOwnerKey)
  first.finish()
})

it('does not infer child settlement from the absence of an inventory verifier', () => {
  const { db, state, policy } = fixture()
  const session = createCodexPoolTurnSession({
    db,
    readState: () => state,
    ownerPrefix: 'unproven',
    canSwitch: () => true
  })
  const first = session.begin(root('0'))
  expect(
    session.replaceRejectedRequest({
      policyId: policy.id,
      expectedRevision: 1,
      excludedAccountIds: ['a'],
      excludedQuotaIdentities: ['a']
    })
  ).toBeNull()
  expect(db.listAccountPoolAssignments()[0].ownerKey).toBe(first.assignmentOwnerKey)
  first.finish()
})

it('applies saved rotation-off revisions without moving the live account or its lease', () => {
  const { session, policy, db, state, create } = fixture()
  session.begin(root('0')).finish()
  const assignment = db.listAccountPoolAssignments()[0]
  policy.revision++
  policy.rotation = 'off'
  policy.members[0].priority = 2
  policy.members[1].priority = 1
  state.manualAccountId = 'unrelated-default'
  const next = session.begin(root('1'))
  expect(next.accountId).toBe('a')
  expect(next.policyRevision).toBe(policy.revision)
  next.finish()
  expect(db.listAccountPoolAssignments()).toEqual([assignment])
  expect(create().begin(root('fresh')).accountId).toBe('b')
})
