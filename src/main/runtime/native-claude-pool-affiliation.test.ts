import { expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import { createNativeClaudePoolAffiliation } from './native-claude-pool-affiliation'

function fixture(initialPoolId?: string, pinned = false) {
  const settings = createGlobalSettingsFixture()
  const first: AccountPoolPolicy = {
    id: 'first',
    provider: 'claude',
    revision: 1,
    strategy: 'sequential',
    applyToNewWork: true,
    rotation: 'after-turn',
    unknownQuota: 'allow',
    allowReserve: false,
    members: []
  }
  const second = { ...first, id: 'second', applyToNewWork: false }
  settings.accountPools = [first, second]
  type Row = { provider: 'claude' | 'codex'; accountId: string; poolId: string }
  const assignments = new Map<string, Row>()
  const affiliation = createNativeClaudePoolAffiliation({
    runtime: { requireStore: () => ({ getSettings: () => settings }) },
    initialPoolId,
    pinned,
    readAssignment: (key) => assignments.get(key) ?? null
  })
  return { first, second, settings, assignments, affiliation }
}

it('retains the assigned pool, including disabled/manual policy and live revisions', () => {
  const f = fixture('first')
  f.first.applyToNewWork = false
  f.first.strategy = 'manual'
  f.first.revision++
  f.second.applyToNewWork = true
  expect(f.affiliation.readPolicy()).toMatchObject({
    id: 'first',
    revision: 2,
    strategy: 'manual',
    applyToNewWork: false
  })
})

it('latches an initially manual session only after a matching host assignment', () => {
  const f = fixture()
  f.first.applyToNewWork = false
  expect(f.affiliation.readPolicy()).toBeUndefined()
  f.first.applyToNewWork = true
  expect(f.affiliation.readPolicy()?.id).toBe('first')
  f.assignments.set('owned', { provider: 'claude', accountId: 'a', poolId: 'first' })
  f.affiliation.onAccountSelected({ accountId: 'a', ownerKey: 'owned' })
  f.first.applyToNewWork = false
  f.second.applyToNewWork = true
  expect(f.affiliation.readPolicy()?.id).toBe('first')
  f.assignments.set('other', { provider: 'claude', accountId: 'b', poolId: 'second' })
  f.affiliation.onAccountSelected({ accountId: 'b', ownerKey: 'other' })
  expect(f.affiliation.readPolicy()?.id).toBe('first')
})

it('does not latch absent, different-account or different-provider assignment hints', () => {
  for (const row of [
    null,
    { provider: 'codex' as const, accountId: 'a', poolId: 'first' },
    { provider: 'claude' as const, accountId: 'other', poolId: 'first' }
  ]) {
    const f = fixture()
    if (row) {
      f.assignments.set('hint', row)
    }
    f.affiliation.onAccountSelected({ accountId: 'a', ownerKey: 'hint' })
    f.affiliation.onAccountSelected({ accountId: 'a' })
    f.first.applyToNewWork = false
    f.second.applyToNewWork = true
    expect(f.affiliation.readPolicy()?.id).toBe('second')
  }
})

it('keeps explicit account pins outside default pool changes', () => {
  const f = fixture('first', true)
  expect(f.affiliation.readPolicy()).toBeUndefined()
  f.affiliation.onAccountSelected({ accountId: 'a', ownerKey: 'anything' })
  expect(f.affiliation.readPolicy()).toBeUndefined()
})

it('refuses a removed or changed-provider assigned pool instead of using another default', () => {
  const f = fixture('first')
  f.first.provider = 'codex'
  expect(() => f.affiliation.readPolicy()).toThrow('changed provider')
  f.settings.accountPools = [f.second]
  expect(() => f.affiliation.readPolicy()).toThrow('not configured')
})

it('does not affiliate an ordinary manual launch until a real pool assignment exists', () => {
  const f = fixture()
  f.first.strategy = 'manual'
  expect(f.affiliation.readPolicy()).toBeUndefined()
  f.first.strategy = 'sequential'
  f.assignments.set('actual-owner', { provider: 'claude', poolId: 'first', accountId: 'a' })
  f.affiliation.onAccountSelected({ accountId: 'a', ownerKey: 'actual-owner' })
  f.first.strategy = 'manual'
  expect(f.affiliation.readPolicy()).toEqual(f.first)
})
