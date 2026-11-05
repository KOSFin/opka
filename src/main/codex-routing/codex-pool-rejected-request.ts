import type { NativeAccountPoolScope } from '../runtime/orchestration/db/account-pool-native-fences'
import { randomUUID } from 'node:crypto'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  acquireAccountPoolAssignmentInTransaction,
  type AccountPoolAssignment
} from '../runtime/orchestration/db/account-pool-assignments'
import type { CodexPoolSelectionState } from './codex-pool-turn-session'
import type { CodexQuotaReplacementRequest } from './codex-host-quota-retry'
export type CodexPoolBinding = {
  accountId: string | null
  quotaIdentity?: string
  policy?: AccountPoolPolicy
  assignment?: AccountPoolAssignment
}
export function replaceCodexRejectedRequest(options: {
  db: OrchestrationDb
  ownerPrefix: string
  assignmentScope?: NativeAccountPoolScope
  state: CodexPoolSelectionState
  binding: CodexPoolBinding | undefined
  request: CodexQuotaReplacementRequest
}) {
  const policy = options.state.policy
  if (
    !policy ||
    policy.id !== options.request.policyId ||
    policy.revision !== options.request.expectedRevision ||
    options.binding?.policy?.id !== policy.id ||
    options.binding.policy.revision !== policy.revision ||
    !options.binding.assignment ||
    options.request.excludedAccountIds.length > 16 ||
    options.request.excludedQuotaIdentities.length > 16 ||
    !options.request.excludedAccountIds.includes(options.binding.accountId ?? '') ||
    !options.request.excludedQuotaIdentities.includes(options.binding.assignment.quotaIdentity) ||
    !policy.applyToNewWork ||
    policy.strategy === 'manual' ||
    policy.rotation === 'off' ||
    policy.provider !== 'codex'
  ) {
    return null
  }
  const candidates = options.state.candidates.filter(
    (candidate) =>
      !options.request.excludedAccountIds.includes(candidate.accountId) &&
      !options.request.excludedQuotaIdentities.includes(candidate.quotaIdentity)
  )
  const db = options.db.db
  db.exec('BEGIN IMMEDIATE')
  try {
    const active = db
      .prepare(
        'SELECT owner_key FROM account_pool_assignments WHERE owner_key=? AND released_at IS NULL'
      )
      .get(options.binding.assignment.ownerKey)
    if (!active) {
      db.exec('ROLLBACK')
      return null
    }
    options.db.releaseAccountPoolAssignment(options.binding.assignment.ownerKey)
    const assignment = acquireAccountPoolAssignmentInTransaction(db, {
      ownerKey: options.assignmentScope?.nextOwnerKey() ?? `${options.ownerPrefix}:${randomUUID()}`,
      policy,
      candidates
    })
    db.exec('COMMIT')
    return { accountId: assignment.accountId, policy: structuredClone(policy), assignment }
  } catch {
    db.exec('ROLLBACK')
    return null
  }
}
