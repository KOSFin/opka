import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  pinAgentSessionAccountHome,
  type AgentSessionAccountHomePin
} from './agent-session-account-home-pin'
function fixture() {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      claimStatus: 'reserved',
      ownerProcess: null,
      provenHandleLinkId: null
    })
  )
  record.providerHandleChain = []
  const pin: AgentSessionAccountHomePin = {
    sessionId: record.sessionId,
    fence: record.lease.runtimeFence,
    spawnToken: record.lease.reservedSpawnToken!,
    expectedHome: record.accountHome,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/synthetic/account-b' },
    now: 3000
  }
  return { record, pin }
}
describe('first native account home pin', () => {
  it('changes only the account home within the exact unused reservation', () => {
    const { record, pin } = fixture()
    expect(pinAgentSessionAccountHome(record, pin)).toEqual({
      ...record,
      accountHome: pin.accountHome,
      updatedAt: pin.now
    })
    expect(record.accountHome).toEqual(pin.expectedHome)
  })
  it.each(['fence', 'spawnToken', 'expectedHome'] as const)(
    'refuses a concurrent change to %s',
    (key) => {
      const { record, pin } = fixture()
      if (key === 'fence') {
        pin.fence++
      }
      if (key === 'spawnToken') {
        pin.spawnToken = 'other'
      }
      if (key === 'expectedHome') {
        pin.expectedHome = { variable: 'CLAUDE_CONFIG_DIR', path: '/other' }
      }
      expect(() => pinAgentSessionAccountHome(record, pin)).toThrow('lost')
    }
  )
  it('does not rewrite an existing provider conversation', () => {
    const { record, pin } = fixture()
    record.providerHandleChain = agentSessionRecordFixture().providerHandleChain
    expect(() => pinAgentSessionAccountHome(record, pin)).toThrow('lost')
  })
  it('refuses a different provider credential variable', () => {
    const { record, pin } = fixture()
    pin.accountHome = { variable: 'CODEX_HOME', path: '/other' }
    expect(() => pinAgentSessionAccountHome(record, pin)).toThrow('provider')
  })
})
