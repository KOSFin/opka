import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { WorkerStartInput } from './worker-start-schema'
import { prepareWorkerPoolAdmission } from './worker-pool-preflight'
import { AccountPoolPolicySchema } from '../../../../../../shared/account-pool-policy'

vi.mock('../../../../account-pool-candidates', () => ({ accountPoolCandidates: () => [] }))
function fixture() {
  const policy = AccountPoolPolicySchema.parse({
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'sequential',
    unknownQuota: 'allow',
    allowReserve: false,
    members: []
  })
  const host = {
    requireStore: () => ({ getSettings: () => ({ accountPools: [policy] }) }),
    getAccountsSnapshot: vi.fn(() => ({}))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight only reads these policy and snapshot methods for an empty synthetic pool.
  const runtime = host as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: policy selection does not access the worker execution fields.
  const params = { agent: 'codex' } as WorkerStartInput
  return { policy, host, runtime, params }
}
it('does not enroll existing work by default and honors explicit account choice', () => {
  const f = fixture()
  expect(prepareWorkerPoolAdmission(f.runtime, f.params)).toBeUndefined()
  f.policy.applyToNewWork = true
  expect(prepareWorkerPoolAdmission(f.runtime, { ...f.params, accountId: 'fixed' })).toBeUndefined()
  expect(f.host.getAccountsSnapshot).not.toHaveBeenCalled()
})
it('uses the opted-in provider default or explicitly selected pool', () => {
  const f = fixture()
  f.policy.applyToNewWork = true
  expect(prepareWorkerPoolAdmission(f.runtime, f.params)?.policy.id).toBe('pool')
  f.policy.applyToNewWork = false
  expect(
    prepareWorkerPoolAdmission(f.runtime, { ...f.params, accountPoolId: 'pool' })?.policy.id
  ).toBe('pool')
})
it('refuses unsupported remote launch before reserving an automatic pool', () => {
  const f = fixture()
  f.policy.applyToNewWork = true
  expect(() => prepareWorkerPoolAdmission(f.runtime, { ...f.params, on: 'other' })).toThrow(
    /owning execution host/
  )
  expect(f.host.getAccountsSnapshot).not.toHaveBeenCalled()
})

it('leaves automatic manual pools on the selected account path', () => {
  const f = fixture()
  f.policy.applyToNewWork = true
  f.policy.strategy = 'manual'
  expect(prepareWorkerPoolAdmission(f.runtime, f.params)).toBeUndefined()
  expect(
    prepareWorkerPoolAdmission(f.runtime, { ...f.params, accountPoolId: 'pool' })?.policy.strategy
  ).toBe('manual')
})
