import { randomUUID } from 'node:crypto'
import type { AccountPoolAssignmentMethods } from './orchestration/db/account-pool-assignments'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import type { NativeAccountPoolScope } from './orchestration/db/account-pool-native-fences'
import type { AccountPoolAdmission } from './orchestration/account-pool-admission'
import { acquireAccountPoolAssignmentInTransaction } from './orchestration/db/account-pool-assignments'

export type ClaudeNativeAssignmentDatabase = {
  acquireAccountPoolAssignment: OmitThisParameter<
    AccountPoolAssignmentMethods['acquireAccountPoolAssignment']
  >
  releaseAccountPoolAssignment: (ownerKey: string) => void
}
export type ClaudeNativeAssignmentAdmission = (
  admission: AccountPoolAdmission
) => ReturnType<AccountPoolAssignmentMethods['acquireAccountPoolAssignment']>

/** Advance the durable capability and reserve its account in the same writer transaction. */
export function acquireClaudeNativeScopedAssignment(
  db: OrchestrationDb,
  scope: NativeAccountPoolScope,
  admission: AccountPoolAdmission
) {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const assignment = acquireAccountPoolAssignmentInTransaction(db.db, {
      ...admission,
      ownerKey: scope.nextOwnerKey()
    })
    db.db.exec('COMMIT')
    return assignment
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

export function claudeNativeAssignmentAdmission(options: {
  launchId: string
  db: ClaudeNativeAssignmentDatabase
  acquireAssignment?: ClaudeNativeAssignmentAdmission
}) {
  return (
    options.acquireAssignment ??
    ((admission: AccountPoolAdmission) =>
      options.db.acquireAccountPoolAssignment({
        ...admission,
        ownerKey: `native-cli:${options.launchId}:${randomUUID()}`
      }))
  )
}
