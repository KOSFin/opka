import type { AccountPoolAssignment } from './orchestration/db/account-pool-assignments'
import { getAccountPoolPolicy, getDefaultAccountPool } from './runtime-account-pool-policy'

type Runtime = Parameters<typeof getDefaultAccountPool>[0]
type Assignment = Pick<AccountPoolAssignment, 'provider' | 'poolId' | 'accountId'>

/** An open session keeps its assigned pool when the default for new work changes. */
export function createNativeClaudePoolAffiliation(options: {
  runtime: Runtime
  initialPoolId?: string
  pinned: boolean
  readAssignment: (ownerKey: string) => Assignment | null
}) {
  let poolId = options.initialPoolId
  return {
    readPolicy() {
      if (options.pinned) {
        return undefined
      }
      const policy = poolId
        ? getAccountPoolPolicy(options.runtime, poolId)
        : getDefaultAccountPool(options.runtime, 'claude')
      if (policy && policy.provider !== 'claude') {
        throw new Error('The native Claude session pool changed provider.')
      }
      return !poolId && policy?.strategy === 'manual' ? undefined : policy
    },
    onAccountSelected(selection: { accountId: string; ownerKey?: string }) {
      if (options.pinned || poolId || !selection.ownerKey) {
        return
      }
      const assignment = options.readAssignment(selection.ownerKey)
      if (assignment?.provider === 'claude' && assignment.accountId === selection.accountId) {
        poolId = assignment.poolId
      }
    }
  }
}
