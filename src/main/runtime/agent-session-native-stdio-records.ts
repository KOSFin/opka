import type Database from '../sqlite/sync-database'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { agentSessionOperationKey } from '../../shared/agent-session-operation-ledger'
import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session-host-authority'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import type { NativeStdioReferenceVerdict } from './native-stdio-external-references'

const INTERNAL_ID =
  /^native_stdio_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REFERENCE_TABLES = [
  'journal_rows',
  'journal_sessions',
  'journal_repairs',
  'journal_imports',
  'journal_set_aside',
  'agent_session_tabs',
  'queued_messages',
  'agent_session_command_receipts',
  'agent_session_attachment_claims'
]
const STORE_TABLES = [
  'agent_session_records',
  'agent_session_operations',
  'agent_session_retired_claim_keys',
  'agent_session_store_meta',
  'agent_session_attachment_sweeps'
]
export type NativeStdioRecordRetirement = {
  sessionId: string
  /** Fence returned by the proven eviction, not the old live owner's fence. */
  releasedFence: number
  operationId: string
  fingerprint: string
  proof: 'exited' | 'pid-absent' | 'not-started'
  readExternalReferences: () => NativeStdioReferenceVerdict
}
function eligible(
  draft: AgentSessionStoreState,
  args: NativeStdioRecordRetirement,
  hostId: string
) {
  const record = draft.records.get(args.sessionId)
  if (
    !record ||
    draft.unreadableRecords.size ||
    !INTERNAL_ID.test(args.sessionId) ||
    record.location.executionHostId !== hostId ||
    record.location.wslDistro !== null ||
    record.location.workspaceId !== FLOATING_TERMINAL_WORKTREE_ID ||
    record.location.workspaceKind !== 'folder' ||
    !['claude', 'codex'].includes(record.provider) ||
    draft.sessionTabs?.tabIdFor(args.sessionId) !== undefined ||
    record.conversationName !== undefined ||
    record.conversationCommand !== undefined ||
    record.rewind !== undefined ||
    record.options !== undefined ||
    record.launchArgs !== undefined ||
    record.permissionMode !== undefined ||
    record.accountPool !== undefined
  ) {
    return false
  }
  const lease = record.lease
  if (
    lease.claimStatus !== 'released' ||
    lease.runtimeFence !== args.releasedFence ||
    lease.ownerProcess ||
    lease.reservedSpawnToken ||
    lease.handoffStage ||
    lease.handoffOperationId ||
    lease.unreconciled ||
    lease.journalCheckpoint ||
    lease.minimumNextFence !== undefined
  ) {
    return false
  }
  const death = lease.deathEvidence
  if (
    !['exited', 'pid-absent', 'not-started'].includes(args.proof) ||
    !death ||
    death.ownerFence !== args.releasedFence - 1 ||
    (args.proof === 'exited' ? death.kind !== 'exit-observed' : death.kind !== 'pid-absent') ||
    (args.proof === 'not-started' &&
      (record.providerHandleChain.length !== 0 || death.detail !== 'reservation never spawned'))
  ) {
    return false
  }
  const key = agentSessionOperationKey('native-stdio', args.operationId)
  const own = draft.operations.get(key)
  if (
    !own ||
    !/^[a-f0-9]{64}$/.test(args.fingerprint) ||
    own.fingerprint !== args.fingerprint ||
    parseAgentSessionOperationTimestamp(args.operationId) !== own.operationTimestamp ||
    own.outcome.status !== 'succeeded' ||
    own.outcome.sessionId !== args.sessionId ||
    own.outcome.launch !== undefined ||
    own.outcome.rewind !== undefined ||
    own.outcome.conversationCommand !== undefined
  ) {
    return false
  }
  for (const [otherKey, operation] of draft.operations) {
    if (otherKey === key) {
      continue
    }
    if (
      operation.outcome.status === 'pending' ||
      operation.outcome.status === 'unknown' ||
      (operation.outcome.status === 'succeeded' && operation.outcome.sessionId === args.sessionId)
    ) {
      return false
    }
  }
  return true
}
function journalClear(db: Database.Database, sessionId: string): boolean {
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").get()) {
      return false
    }
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' LIMIT 65"
      )
      .all()
    if (
      tables.length > 64 ||
      tables.some(
        (row) =>
          typeof row.name !== 'string' || ![...REFERENCE_TABLES, ...STORE_TABLES].includes(row.name)
      )
    ) {
      return false
    }
    for (const table of REFERENCE_TABLES) {
      if (
        tables.some((row) => row.name === table) &&
        db.prepare(`SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`).get(sessionId)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}
/** Only disposable internal transport records retire; the timestamped replay fence stays. */
export function createAgentSessionNativeStdioRecords(
  transactions: Pick<AgentSessionStoreTransactions, 'receipt' | 'commitReceipt'>,
  hostId: string
) {
  return {
    async retire(args: NativeStdioRecordRetirement): Promise<boolean> {
      let currentDb: Database.Database | undefined
      let retired = false
      const receipt = transactions.receipt((draft) => {
        if (
          !currentDb ||
          !eligible(draft, args, hostId) ||
          args.readExternalReferences() !== 'clear' ||
          !journalClear(currentDb, args.sessionId)
        ) {
          return
        }
        const operationCount = currentDb
          .prepare('SELECT COUNT(*) AS count FROM agent_session_operations')
          .get()
        if (!operationCount || operationCount.count !== draft.operations.size) {
          return
        }
        draft.records.delete(args.sessionId)
        retired = true
      })
      await transactions.commitReceipt({
        write(db) {
          currentDb = db
          try {
            receipt.write(db)
          } finally {
            currentDb = undefined
          }
        },
        committed() {
          receipt.committed()
        }
      })
      return retired
    }
  }
}
