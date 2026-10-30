import { z } from 'zod'
import type Database from '../../../sqlite/sync-database'
import type { OrchestrationDb } from './orchestration-db'
import { selectAccountPoolMember, type AccountPoolAdmission } from '../account-pool-admission'

export const ACCOUNT_POOL_ASSIGNMENTS_SQL = `
CREATE TABLE IF NOT EXISTS account_pool_assignments (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  quota_identity TEXT NOT NULL,
  released_at TEXT
);
CREATE TABLE IF NOT EXISTS account_pool_pty_bindings (
  owner_key TEXT PRIMARY KEY REFERENCES account_pool_assignments(owner_key),
  pty_id TEXT NOT NULL,
  incarnation_id TEXT
);
CREATE INDEX IF NOT EXISTS account_pool_assignments_active ON account_pool_assignments(provider, quota_identity) WHERE released_at IS NULL;
CREATE TRIGGER IF NOT EXISTS release_worker_account_pool_assignment
AFTER UPDATE OF state ON worker_dispatches
WHEN NEW.state IN ('failed','stopped','succeeded','abandoned')
BEGIN
  UPDATE account_pool_assignments SET released_at = datetime('now') WHERE owner_key = 'worker:' || NEW.dispatch_id AND released_at IS NULL;
END;
`
const AssignmentRow = z.object({
  sequence: z.number(),
  owner_key: z.string(),
  provider: z.enum(['claude', 'codex']),
  pool_id: z.string(),
  policy_revision: z.number(),
  account_id: z.string(),
  quota_identity: z.string(),
  released_at: z.string().nullable(),
  pty_id: z.string().nullable().optional(),
  incarnation_id: z.string().nullable().optional()
})
function decodeAssignment(row: unknown) {
  const value = AssignmentRow.parse(row)
  return {
    ownerKey: value.owner_key,
    provider: value.provider,
    poolId: value.pool_id,
    policyRevision: value.policy_revision,
    accountId: value.account_id,
    quotaIdentity: value.quota_identity,
    sequence: value.sequence,
    releasedAt: value.released_at,
    ptyId: value.pty_id ?? null,
    incarnationId: value.incarnation_id ?? null
  }
}
export type AccountPoolAssignment = ReturnType<typeof decodeAssignment>
export type AcquireAccountPoolAssignment = AccountPoolAdmission & { ownerKey: string }

// The caller owns the writer transaction, including dispatch acceptance when applicable.
export function acquireAccountPoolAssignmentInTransaction(
  db: Database.Database,
  args: AcquireAccountPoolAssignment
): AccountPoolAssignment {
  const existing = db
    .prepare('SELECT * FROM account_pool_assignments WHERE owner_key=?')
    .get(args.ownerKey)
  if (existing) {
    const assignment = decodeAssignment(existing)
    if (
      assignment.releasedAt ||
      assignment.poolId !== args.policy.id ||
      assignment.provider !== args.policy.provider
    ) {
      throw new Error('Account assignment owner is already bound; use a new execution generation')
    }
    return assignment
  }
  const selected = selectAccountPoolMember(db, args)
  db.prepare(`INSERT INTO account_pool_assignments (owner_key, provider, pool_id, policy_revision, account_id, quota_identity)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    args.ownerKey,
    selected.provider,
    args.policy.id,
    args.policy.revision,
    selected.id,
    selected.quotaIdentity
  )
  return decodeAssignment(
    db.prepare('SELECT * FROM account_pool_assignments WHERE owner_key=?').get(args.ownerKey)
  )
}
export function acquireAccountPoolAssignment(
  this: OrchestrationDb,
  args: AcquireAccountPoolAssignment
): AccountPoolAssignment {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const assignment = acquireAccountPoolAssignmentInTransaction(this.db, args)
    this.db.exec('COMMIT')
    return assignment
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}
export function bindAccountPoolAssignmentPty(
  this: OrchestrationDb,
  args: { ownerKey: string; ptyId: string; incarnationId?: string }
): void {
  const active = this.db
    .prepare(
      'SELECT owner_key FROM account_pool_assignments WHERE owner_key=? AND released_at IS NULL'
    )
    .get(args.ownerKey)
  if (!active) {
    throw new Error('Account assignment is no longer active')
  }
  const previous = this.db
    .prepare('SELECT pty_id, incarnation_id FROM account_pool_pty_bindings WHERE owner_key=?')
    .get(args.ownerKey)
  if (
    previous &&
    (previous.pty_id !== args.ptyId || previous.incarnation_id !== (args.incarnationId ?? null))
  ) {
    throw new Error('Account assignment already belongs to another terminal generation')
  }
  this.db
    .prepare(
      'INSERT OR IGNORE INTO account_pool_pty_bindings(owner_key, pty_id, incarnation_id) VALUES (?, ?, ?)'
    )
    .run(args.ownerKey, args.ptyId, args.incarnationId ?? null)
}
export function releaseAccountPoolAssignment(this: OrchestrationDb, ownerKey: string): void {
  this.db
    .prepare(
      "UPDATE account_pool_assignments SET released_at=datetime('now') WHERE owner_key=? AND released_at IS NULL"
    )
    .run(ownerKey)
}
export function releaseAccountPoolPtyGeneration(
  this: OrchestrationDb,
  ptyId: string,
  incarnationId: string | undefined
): void {
  if (!incarnationId) {
    return
  }
  this.db
    .prepare(`UPDATE account_pool_assignments SET released_at=datetime('now')
    WHERE released_at IS NULL AND owner_key IN
    (SELECT owner_key FROM account_pool_pty_bindings WHERE pty_id=? AND incarnation_id=?)`)
    .run(ptyId, incarnationId)
}
export function listAccountPoolAssignments(this: OrchestrationDb): AccountPoolAssignment[] {
  return this.db
    .prepare(
      'SELECT a.*, b.pty_id, b.incarnation_id FROM account_pool_assignments a LEFT JOIN account_pool_pty_bindings b ON b.owner_key=a.owner_key WHERE a.released_at IS NULL ORDER BY a.sequence'
    )
    .all()
    .map(decodeAssignment)
}
export type AccountPoolAssignmentMethods = {
  releaseAccountPoolPtyGeneration: typeof releaseAccountPoolPtyGeneration
  bindAccountPoolAssignmentPty: typeof bindAccountPoolAssignmentPty
  acquireAccountPoolAssignment: typeof acquireAccountPoolAssignment
  releaseAccountPoolAssignment: typeof releaseAccountPoolAssignment
  listAccountPoolAssignments: typeof listAccountPoolAssignments
}
export function attachAccountPoolAssignments(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    releaseAccountPoolPtyGeneration,
    bindAccountPoolAssignmentPty,
    acquireAccountPoolAssignment,
    releaseAccountPoolAssignment,
    listAccountPoolAssignments
  })
}
