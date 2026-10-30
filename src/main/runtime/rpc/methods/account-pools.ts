import { defineMethod } from '../core'
import {
  ACCOUNT_POOL_CAPABILITY,
  AccountPoolPolicySchema,
  AccountPoolUpdateParams
} from '../../../../shared/account-pool-policy'
import { accountPoolCandidates } from '../../account-pool-candidates'

export const ACCOUNT_POOL_METHODS = [
  defineMethod({
    name: 'accountPool.list',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => {
      const accounts = runtime.getAccountsSnapshot()
      return {
        capability: ACCOUNT_POOL_CAPABILITY,
        policies: (runtime.requireStore().getSettings().accountPools ?? []).map((policy) =>
          AccountPoolPolicySchema.parse(policy)
        ),
        accounts,
        candidates: accountPoolCandidates(accounts),
        assignments: runtime.getOrchestrationDb().listAccountPoolAssignments()
      }
    }
  }),
  defineMethod({
    name: 'accountPool.update',
    permission: 'accounts-admin',
    params: AccountPoolUpdateParams,
    handler: async ({ policy, expectedRevision }, { runtime }) => {
      const store = runtime.requireStore()
      if (!store.runDurableMutation || !store.updateSettings) {
        throw new Error('Durable account policies are unavailable on this host')
      }
      const accounts = runtime.getAccountsSnapshot()[policy.provider].accounts
      if (
        policy.members.some(
          (member) => !accounts.some((account) => account.id === member.accountId)
        )
      ) {
        throw new Error('All pool members must be registered on this execution host')
      }
      const applySettings = store.updateSettings.bind(store)
      const committed = await store.runDurableMutation(() => {
        const before = store.getSettings().accountPools ?? []
        const current = before.find((entry) => entry.id === policy.id)
        if ((current?.revision ?? 0) !== expectedRevision) {
          throw new Error('Account pool changed; reload before saving')
        }
        if (current && current.provider !== policy.provider) {
          throw new Error('A pool provider cannot change')
        }
        if (
          policy.applyToNewWork &&
          before.some(
            (entry) =>
              entry.id !== policy.id && entry.provider === policy.provider && entry.applyToNewWork
          )
        ) {
          throw new Error(
            'Disable the current default pool for this provider before enabling another'
          )
        }
        const saved = { ...policy, revision: expectedRevision + 1 }
        applySettings(
          { accountPools: [...before.filter((entry) => entry.id !== saved.id), saved] },
          { notifyListeners: true }
        )
        return {
          value: saved,
          rollback: () => applySettings({ accountPools: before }, { notifyListeners: true })
        }
      })
      return committed
    }
  })
]
