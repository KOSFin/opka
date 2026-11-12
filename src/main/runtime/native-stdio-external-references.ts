import { lstatSync } from 'node:fs'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import { SCHEMA_VERSION } from './orchestration/db/contract-constants'
import { TaskDelegationGrant } from '../../shared/project-task-delegation'

export type NativeStdioReferenceVerdict = 'clear' | 'present' | 'unverifiable'
// A maximal valid grant has 1,000 256-character task IDs, even when JSON escapes each character.
const MAX_DELEGATION_GRANT_BYTES = 2 * 1024 * 1024
const KNOWN_TABLES = new Set([
  'runs',
  'messages',
  'run_coordinator_handles',
  'deliveries',
  'mutation_receipts',
  'mutation_receipt_ledger',
  'mutation_caller_identities',
  'attempt_observation_facts',
  'worker_dispatches',
  'worker_terminal_resources',
  'structured_pointer_operations',
  'worker_terminal_archives',
  'federated_dispatches',
  'remote_dispatch_attachments',
  'federation_relay_items',
  'remote_questions',
  'tasks',
  'dispatch_contexts',
  'coordinator_runs',
  'decision_gates',
  'question_threads',
  'legacy_adoptions',
  'legacy_compatibility_principals',
  'legacy_mail_receipts',
  'legacy_operation_receipts',
  'account_pool_assignments',
  'account_pool_pty_bindings',
  'account_pool_replacement_claims',
  'account_pool_native_epochs',
  'account_pool_native_scopes',
  'project_task_homes',
  'project_task_items',
  'project_task_graph',
  'project_task_attempt_placements',
  'project_task_attempts',
  'project_task_session_attempts',
  'project_task_events',
  'project_task_delegation_policy',
  'project_task_delegation_proposals',
  'project_task_delegation_mutations',
  'project_task_delegation_audit',
  'project_task_delegated_plans',
  'project_task_admissions',
  'project_task_results',
  'project_task_review_assignments',
  'project_task_reviews',
  'project_task_acceptances'
])
function readAdditionalReferenceColumns(
  db: OrchestrationDb['db'],
  sessionId: string
): NativeStdioReferenceVerdict {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' LIMIT 65"
    )
    .all()
  if (
    tables.length > 64 ||
    tables.some((table) => typeof table.name !== 'string' || !KNOWN_TABLES.has(table.name))
  ) {
    return 'unverifiable'
  }
  for (const table of tables) {
    if (typeof table.name !== 'string' || !/^[a-z_]+$/.test(table.name)) {
      return 'unverifiable'
    }
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all()
    if (columns.length > 64) {
      return 'unverifiable'
    }
    for (const column of columns) {
      if (typeof column.name !== 'string' || !/^[a-z_0-9]+$/.test(column.name)) {
        return 'unverifiable'
      }
      if (!/(?:^|_)(?:handle|session_id|process_incarnation)$/.test(column.name)) {
        continue
      }
      if (
        db
          .prepare(`SELECT 1 FROM ${table.name} WHERE ${column.name} IN (?,?,?,?) LIMIT 1`)
          .get(
            sessionId,
            `orca_session_id:${sessionId}`,
            `session:${sessionId}`,
            `structured:${sessionId}`
          )
      ) {
        return 'present'
      }
    }
  }
  return 'clear'
}
function readActiveDelegationReferences(
  db: OrchestrationDb['db'],
  sessionId: string
): NativeStdioReferenceVerdict {
  const now = Date.now()
  const addresses = new Set([sessionId, `orca_session_id:${sessionId}`, `session:${sessionId}`])
  for (const [table, proposal] of [
    ['project_task_delegation_policy', false],
    ['project_task_delegation_proposals', true]
  ] as const) {
    let count = 0
    for (const _ of db
      .prepare(`SELECT 1 FROM ${table} WHERE grant_json IS NOT NULL LIMIT 65`)
      .iterate()) {
      if (++count > 64) {
        return 'unverifiable'
      }
    }
    const sql = `SELECT CASE WHEN length(CAST(grant_json AS BLOB)) <= ${MAX_DELEGATION_GRANT_BYTES} THEN grant_json END AS grant_json${proposal ? ',expires_at' : ''} FROM ${table} WHERE grant_json IS NOT NULL`
    for (const row of db.prepare(sql).iterate()) {
      if (typeof row.grant_json !== 'string') {
        return 'unverifiable'
      }
      const proposalExpiresAt = row.expires_at
      if (
        proposal &&
        (typeof proposalExpiresAt !== 'number' ||
          !Number.isSafeInteger(proposalExpiresAt) ||
          proposalExpiresAt <= 0)
      ) {
        return 'unverifiable'
      }
      const grant = TaskDelegationGrant.parse(JSON.parse(row.grant_json))
      if (
        (grant.expiresAt !== null && grant.expiresAt <= now) ||
        (proposal && typeof proposalExpiresAt === 'number' && proposalExpiresAt <= now)
      ) {
        continue
      }
      if (grant.schema === 1 && addresses.has(grant.actorAddress)) {
        return 'present'
      }
    }
  }
  return 'clear'
}
/** Read metadata only; an unopened database is not absence unless its trusted path is absent. */
export function readNativeStdioExternalReferences(
  args: {
    db: OrchestrationDb | null
    databasePath?: string
    assertExclusive: () => void
  },
  sessionId: string
): NativeStdioReferenceVerdict {
  try {
    args.assertExclusive()
    if (!args.db) {
      if (!args.databasePath) {
        return 'unverifiable'
      }
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          lstatSync(`${args.databasePath}${suffix}`)
          return 'unverifiable'
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            return 'unverifiable'
          }
        }
      }
      args.assertExclusive()
      return 'clear'
    }
    const db = args.db.db
    if (db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION) {
      return 'unverifiable'
    }
    const addresses = [`orca_session_id:${sessionId}`, `session:${sessionId}`, sessionId]
    const incarnation = `structured:${sessionId}`
    const references: readonly [string, readonly string[]][] = [
      [
        'SELECT 1 FROM runs WHERE coordinator_orca_session_id=? OR coordinator_handle IN (?,?,?) LIMIT 1',
        [sessionId, ...addresses]
      ],
      [
        'SELECT 1 FROM dispatch_contexts WHERE assignee_orca_session_id=? OR creator_orca_session_id=? OR assignee_handle IN (?,?,?) OR creator_handle IN (?,?,?) OR process_incarnation=? LIMIT 1',
        [sessionId, sessionId, ...addresses, ...addresses, incarnation]
      ],
      [
        'SELECT 1 FROM messages WHERE from_handle IN (?,?,?) OR to_handle IN (?,?,?) LIMIT 1',
        [...addresses, ...addresses]
      ],
      ['SELECT 1 FROM worker_dispatches WHERE agent_terminal_handle IN (?,?,?) LIMIT 1', addresses],
      [
        'SELECT 1 FROM worker_terminal_resources WHERE terminal_handle IN (?,?,?) OR process_incarnation=? LIMIT 1',
        [...addresses, incarnation]
      ],
      ['SELECT 1 FROM run_coordinator_handles WHERE terminal_handle IN (?,?,?) LIMIT 1', addresses],
      ['SELECT 1 FROM coordinator_runs WHERE coordinator_handle IN (?,?,?) LIMIT 1', addresses],
      ['SELECT 1 FROM deliveries WHERE mailbox_handle IN (?,?,?) LIMIT 1', addresses],
      [
        'SELECT 1 FROM structured_pointer_operations WHERE session_id=? OR mailbox_handle IN (?,?,?) LIMIT 1',
        [sessionId, ...addresses]
      ],
      [
        'SELECT 1 FROM remote_dispatch_attachments WHERE terminal_handle IN (?,?,?) OR process_incarnation=? LIMIT 1',
        [...addresses, incarnation]
      ],
      [
        'SELECT 1 FROM federated_dispatches WHERE remote_terminal_handle IN (?,?,?) LIMIT 1',
        addresses
      ],
      ['SELECT 1 FROM tasks WHERE created_by_terminal_handle IN (?,?,?) LIMIT 1', addresses]
    ]
    for (const [sql, params] of references) {
      if (db.prepare(sql).get(...params)) {
        return 'present'
      }
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM worker_dispatches WHERE state IN ('starting','start_unknown','stopping','stop_unknown') LIMIT 1"
        )
        .get() ||
      db
        .prepare(
          "SELECT 1 FROM remote_dispatch_attachments WHERE state IN ('starting','start_unknown','stopping','stop_unknown') LIMIT 1"
        )
        .get() ||
      db.prepare("SELECT 1 FROM mutation_receipts WHERE state='pending' LIMIT 1").get()
    ) {
      return 'unverifiable'
    }
    const additional = readAdditionalReferenceColumns(db, sessionId)
    if (additional !== 'clear') {
      return additional
    }
    const delegation = readActiveDelegationReferences(db, sessionId)
    args.assertExclusive()
    return delegation
  } catch {
    return 'unverifiable'
  }
}
