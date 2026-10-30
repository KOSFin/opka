import { describe, expect, it } from 'vitest'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { accountPoolRotationBoundary } from './account-pool-rotation-boundary'
function fixture(): Parameters<typeof accountPoolRotationBoundary>[0] & {
  row: AgentStatusIpcPayload
} {
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'balanced',
    applyToNewWork: true,
    rotation: 'after-turn',
    unknownQuota: 'allow',
    allowReserve: false,
    members: [{ accountId: 'a', priority: 1, weight: 1, state: 'enabled', role: 'primary' }]
  }
  const row: AgentStatusIpcPayload = {
    paneKey: 'synthetic',
    executionId: 'generation',
    connectionId: null,
    receivedAt: 2000,
    stateStartedAt: 2000,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    turnStartedAt: 1500,
    turnCompletedAt: 2000,
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 2000 },
    providerSession: { key: 'session_id', id: 'synthetic-provider-session' },
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'host',
      incarnation: 1,
      revision: 2,
      observedAt: 2000
    }
  }
  const children: AgentChildWorkView[] | undefined = []
  return {
    policy,
    row,
    children,
    accountId: 'a',
    candidate: undefined,
    executionId: 'generation',
    launchStartedAt: 1000,
    now: 2500
  }
}
describe('account pool automatic rotation boundary', () => {
  it('admits a fresh completed owning-host turn with settled inventory', () => {
    expect(accountPoolRotationBoundary(fixture())).toBe(2000)
  })
  it.each(['isReplay', 'restoredUnconfirmed', 'sessionBoundary', 'interrupted'] as const)(
    'rejects %s',
    (field) => {
      const f = fixture()
      f.row[field] = true
      expect(accountPoolRotationBoundary(f)).toBeNull()
    }
  )
  it('rejects terminal-title and launch observations even when they paint done', () => {
    const f = fixture()
    for (const origin of ['title', 'launch', 'process', 'osc'] as const) {
      f.row.observation = {
        origin,
        kind: 'transition',
        authorityId: 'host',
        incarnation: 1,
        revision: 2,
        observedAt: 2000
      }
      expect(accountPoolRotationBoundary(f)).toBeNull()
    }
  })
  it('waits for child settlement even when that child currently looks idle', () => {
    const f = fixture()
    f.children = [
      {
        id: 'child',
        kind: 'agent',
        state: 'idle',
        membership: 'live',
        firstObservedAt: 1500,
        observedAt: 2000,
        stoppable: true,
        invocation: { invocationId: 'child-turn', generation: 1 }
      }
    ]
    expect(accountPoolRotationBoundary(f)).toBeNull()
  })
  it('rejects another process generation and repeated completion', () => {
    expect(accountPoolRotationBoundary({ ...fixture(), executionId: 'other' })).toBeNull()
    expect(accountPoolRotationBoundary({ ...fixture(), lastRotatedTurn: 2000 })).toBeNull()
  })
  it('rejects unknown child inventory, pending approval and absent completion clock', () => {
    const f = fixture()
    f.children = undefined
    expect(accountPoolRotationBoundary(f)).toBeNull()
    f.children = []
    f.row.state = 'blocked'
    expect(accountPoolRotationBoundary(f)).toBeNull()
    f.row.state = 'done'
    f.row.turnCompletedAt = undefined
    expect(accountPoolRotationBoundary(f)).toBeNull()
  })
  it('does not infer a rotation from unknown quota or unsuccessful cancellation', () => {
    const f = fixture()
    f.policy.rotation = 'on-limit'
    expect(accountPoolRotationBoundary(f)).toBeNull()
    f.policy.members[0].state = 'draining'
    expect(accountPoolRotationBoundary(f)).toBe(2000)
    f.row.mainAgent = { state: 'done', outcome: 'cancellation', stateStartedAt: 2000 }
    expect(accountPoolRotationBoundary(f)).toBeNull()
  })
  it('rejects stale, future and prelaunch turn clocks', () => {
    expect(accountPoolRotationBoundary({ ...fixture(), now: 65_000 })).toBeNull()
    expect(accountPoolRotationBoundary({ ...fixture(), now: 1900 })).toBeNull()
    expect(accountPoolRotationBoundary({ ...fixture(), launchStartedAt: 1600 })).toBeNull()
  })
})
