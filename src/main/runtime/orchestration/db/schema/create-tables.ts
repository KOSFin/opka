import { NATIVE_ACCOUNT_POOL_FENCES_SQL } from '../account-pool-native-fences'
import { ACCOUNT_POOL_ASSIGNMENTS_SQL } from '../account-pool-assignments'
import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { DERIVED_DELIVERY_SCHEMA_SQL } from './migrate-v41'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(`${createCoreTablesSql()}\n${createGraphTablesSql()}`)
  this.createMailboxDeliveryIndexesIfPossible()
  this.db.exec(DERIVED_DELIVERY_SCHEMA_SQL)
  this.db.exec(ACCOUNT_POOL_ASSIGNMENTS_SQL)
  this.db.exec(NATIVE_ACCOUNT_POOL_FENCES_SQL)
}

export type CreateTablesMethods = {
  createTables: typeof createTables
}

export function attachCreateTables(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTables
  })
}
