import { afterEach } from 'vitest'
import type { AcquireAccountPoolAssignment } from './account-pool-assignments'
import { acquireAccountPoolAssignmentInTransaction } from './account-pool-assignments'
import { beginNativeAccountPoolEpoch } from './account-pool-native-fences'
import { OrchestrationDb } from './orchestration-db'

const stores: OrchestrationDb[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
export function nativeAccountPoolFenceFixture() {
  const store = new OrchestrationDb(':memory:')
  stores.push(store)
  let exclusive = true,
    idle = true
  const proof = {
    assertExclusive() {
      if (!exclusive) {
        throw new Error('stale profile')
      }
    },
    assertWriterIdle() {
      if (!idle) {
        throw new Error('unverifiable writer')
      }
    }
  }
  const epoch = beginNativeAccountPoolEpoch(store.db, proof)
  const args: Omit<AcquireAccountPoolAssignment, 'ownerKey'> = {
    policy: {
      id: 'pool',
      provider: 'codex',
      revision: 1,
      strategy: 'balanced',
      applyToNewWork: true,
      rotation: 'after-turn',
      unknownQuota: 'allow',
      allowReserve: false,
      members: ['a', 'b'].map((accountId) => ({
        accountId,
        priority: 1,
        weight: 1,
        maxConcurrent: 1,
        state: 'enabled',
        role: 'primary'
      }))
    },
    candidates: ['a', 'b'].map((accountId) => ({
      accountId,
      quotaIdentity: accountId,
      auth: 'ready',
      quota: 'available',
      usedPercent: 10
    }))
  }
  const allocate = (scope: ReturnType<typeof epoch.registerScope>) => {
    store.db.exec('BEGIN IMMEDIATE')
    try {
      const assignment = acquireAccountPoolAssignmentInTransaction(store.db, {
        ...args,
        ownerKey: scope.nextOwnerKey()
      })
      store.db.exec('COMMIT')
      return assignment
    } catch (error) {
      store.db.exec('ROLLBACK')
      throw error
    }
  }
  return {
    store,
    epoch,
    proof,
    args,
    allocate,
    setExclusive: (value: boolean) => {
      exclusive = value
    },
    setIdle: (value: boolean) => {
      idle = value
    }
  }
}
