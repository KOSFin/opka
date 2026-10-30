import type Database from '../../sqlite/sync-database'
import { resolveWorkerConcurrencyLimit } from '../../../shared/worker-concurrency-limit'
import { OrchestrationError } from './orchestration-error'

export function assertWorkerCapacity(db: Database.Database, configuredLimit?: number | null): void {
  const limit = resolveWorkerConcurrencyLimit(configuredLimit)
  if (limit === undefined) {
    return
  }
  const row = db
    .prepare(`SELECT (
    SELECT COUNT(*) FROM worker_dispatches w
    WHERE w.state IN ('starting','ready','start_unknown','stopping','stop_unknown')
      AND NOT EXISTS (SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id=w.dispatch_id)
  ) + (
    SELECT COUNT(*) FROM remote_dispatch_attachments
    WHERE state IN ('starting','ready','start_unknown','stopping','stop_unknown')
  ) AS active`)
    .get()
  if (Number(row?.active ?? 0) >= limit) {
    throw new OrchestrationError(
      'worker_capacity_exceeded',
      `Worker limit reached on this host (${limit} active or unverifiable workers). Finish or stop an existing worker before launching another. Unconfirmed workers still count toward the limit.`,
      { effectsApplied: false }
    )
  }
}
