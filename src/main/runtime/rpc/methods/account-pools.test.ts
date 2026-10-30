import { expect, it, vi } from 'vitest'
import {
  AccountPoolUpdateParams,
  type AccountPoolPolicy
} from '../../../../shared/account-pool-policy'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { ACCOUNT_POOL_METHODS } from './account-pools'

function fixture() {
  let policies: AccountPoolPolicy[] = []
  const updateSettings = vi.fn((updates: { accountPools: AccountPoolPolicy[] }) => {
    policies = updates.accountPools
  })
  const store = {
    getSettings: () => ({ accountPools: policies }),
    updateSettings,
    runDurableMutation: async <T>(mutate: () => { value: T }) => mutate().value
  }
  const host = {
    requireStore: () => store,
    getAccountsSnapshot: () => ({ claude: { accounts: [] }, codex: { accounts: [{ id: 'a' }] } })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the update handler only accesses these stubbed settings and account methods.
  const runtime = host as unknown as OrcaRuntimeService
  const found = eraseRpcMethods(ACCOUNT_POOL_METHODS).find(
    (method) => method.name === 'accountPool.update'
  )
  if (!found || isStreamingMethod(found)) {
    throw new Error('Missing request method')
  }
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'codex',
    revision: 0,
    strategy: 'sequential',
    applyToNewWork: false,
    rotation: 'off',
    unknownQuota: 'exclude',
    allowReserve: false,
    members: [{ accountId: 'a', priority: 1, weight: 1, state: 'enabled', role: 'primary' }]
  }
  const update = async (value = policy, expectedRevision = 0) =>
    found.handler(found.params?.parse({ policy: value, expectedRevision }), { runtime })
  return { update, updateSettings, policy, policies: () => policies }
}
it('persists host-local metadata with compare-and-swap revisions and no credential mutation', async () => {
  const f = fixture()
  expect(await f.update()).toMatchObject({ id: 'pool', revision: 1 })
  await expect(f.update()).rejects.toThrow(/reload before saving/)
  expect(f.updateSettings).toHaveBeenCalledTimes(1)
  expect(await f.update({ ...f.policy, strategy: 'balanced' }, 1)).toMatchObject({ revision: 2 })
  expect(f.policies()[0].strategy).toBe('balanced')
})
it('refuses foreign host registrations and duplicate membership before saving', async () => {
  const f = fixture()
  await expect(
    f.update({ ...f.policy, members: [{ ...f.policy.members[0], accountId: 'foreign' }] })
  ).rejects.toThrow(/registered on this execution host/)
  await expect(
    f.update({ ...f.policy, members: [f.policy.members[0], f.policy.members[0]] })
  ).rejects.toThrow(/only once/)
  expect(f.updateSettings).not.toHaveBeenCalled()
})

it('requires an explicit default opt-in and only one default per provider', async () => {
  const f = fixture()
  await f.update({ ...f.policy, applyToNewWork: true, rotation: 'on-limit' })
  await expect(f.update({ ...f.policy, id: 'other', applyToNewWork: true })).rejects.toThrow(
    /Disable the current default/
  )
  await f.update({ ...f.policy, applyToNewWork: false }, 1)
  await expect(f.update({ ...f.policy, id: 'other', applyToNewWork: true })).resolves.toMatchObject(
    {
      id: 'other',
      applyToNewWork: true
    }
  )
})
it('defaults old policies to no automatic enrollment or rotation', async () => {
  const f = fixture()
  const { applyToNewWork: _apply, rotation: _rotation, ...oldPolicy } = f.policy
  const parsed = AccountPoolUpdateParams.parse({ policy: oldPolicy, expectedRevision: 0 })
  expect(parsed.policy).toMatchObject({ applyToNewWork: false, rotation: 'off' })
})
