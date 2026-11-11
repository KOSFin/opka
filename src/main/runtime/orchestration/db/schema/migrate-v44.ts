import type { OrchestrationDb } from '../orchestration-db'

export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  if (!this.hasColumn('account_pool_assignments', 'selection_reason')) {
    this.db.exec('ALTER TABLE account_pool_assignments ADD COLUMN selection_reason TEXT')
  }
}
