import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type Database from '../../../sqlite/sync-database'

export const NATIVE_POOL_SCOPE_PREFIX = 'native-scope-v2:'
export const NativePoolProvider = z.enum(['codex', 'claude'])
export const NativePoolCounter = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1)
export const NativePoolEpochRow = z.object({ epoch: NativePoolCounter })
export const NativePoolScopeRow = z.object({
  provider: NativePoolProvider,
  epoch: NativePoolCounter,
  generation: NativePoolCounter
})
export type NativeAccountPoolProvider = z.infer<typeof NativePoolProvider>
export type NativeAccountPoolScope = {
  /** Called inside the allocation's existing BEGIN IMMEDIATE transaction. */
  nextOwnerKey: () => string
  close: () => void
}

/** Recovery and read-only attachment share the same scope/host fencing rules. */
export function createNativeAccountPoolScopeRegistry(
  db: Database.Database,
  proof: { assertExclusive: () => void },
  provider: NativeAccountPoolProvider,
  epoch: number,
  compactReleased: () => void
) {
  const assertCurrent = () => {
    proof.assertExclusive()
    if (
      NativePoolEpochRow.parse(
        db.prepare('SELECT epoch FROM account_pool_native_epochs WHERE provider=?').get(provider)
      ).epoch !== epoch
    ) {
      throw new Error('Native account assignment epoch is stale')
    }
  }
  return {
    registerScope(): NativeAccountPoolScope {
      assertCurrent()
      const scopeId = randomUUID()
      db.exec('BEGIN IMMEDIATE')
      try {
        assertCurrent()
        db.prepare(
          'INSERT INTO account_pool_native_scopes(scope_id,provider,epoch,generation) VALUES(?,?,?,0)'
        ).run(scopeId, provider, epoch)
        assertCurrent()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      let closed = false
      return {
        nextOwnerKey() {
          if (!db.isTransaction) {
            throw new Error('Native account allocation requires an active transaction')
          }
          assertCurrent()
          const scope = NativePoolScopeRow.safeParse(
            db
              .prepare(
                'SELECT provider,epoch,generation FROM account_pool_native_scopes WHERE scope_id=?'
              )
              .get(scopeId)
          )
          if (
            closed ||
            !scope.success ||
            scope.data.epoch !== epoch ||
            scope.data.provider !== provider
          ) {
            throw new Error('Native account assignment scope is revoked')
          }
          const prefix = `${NATIVE_POOL_SCOPE_PREFIX}${provider}:${epoch}:${scopeId}:`
          const active = db
            .prepare(`SELECT owner_key FROM account_pool_assignments
            INDEXED BY account_pool_native_active_scope_v2
            WHERE released_at IS NULL AND owner_key >= 'native-scope-v2:' AND owner_key < 'native-scope-v2;'
            AND owner_key >= ? AND owner_key < ? LIMIT 2`)
            .all(prefix, `${NATIVE_POOL_SCOPE_PREFIX}${provider}:${epoch}:${scopeId};`)
          if (active.length >= 2) {
            throw new Error('Native account scope retained-work capacity requires recovery')
          }
          const generation = NativePoolCounter.parse(scope.data.generation + 1)
          db.prepare(
            'UPDATE account_pool_native_scopes SET generation=? WHERE scope_id=? AND epoch=? AND provider=?'
          ).run(generation, scopeId, epoch, provider)
          return `${NATIVE_POOL_SCOPE_PREFIX}${provider}:${epoch}:${scopeId}:${generation}`
        },
        close() {
          if (closed) {
            return
          }
          assertCurrent()
          db.exec('BEGIN IMMEDIATE')
          try {
            assertCurrent()
            const scope = NativePoolScopeRow.safeParse(
              db
                .prepare(
                  'SELECT provider,epoch,generation FROM account_pool_native_scopes WHERE scope_id=?'
                )
                .get(scopeId)
            )
            if (!scope.success || scope.data.provider !== provider || scope.data.epoch !== epoch) {
              throw new Error('Native assignment scope closure is unverifiable')
            }
            const prefix = `${NATIVE_POOL_SCOPE_PREFIX}${provider}:${epoch}:${scopeId}:`
            db.prepare(
              "UPDATE account_pool_assignments SET released_at=datetime('now') WHERE owner_key>=? AND owner_key<? AND released_at IS NULL"
            ).run(prefix, `${NATIVE_POOL_SCOPE_PREFIX}${provider}:${epoch}:${scopeId};`)
            db.prepare(
              'DELETE FROM account_pool_native_scopes WHERE scope_id=? AND epoch=? AND provider=?'
            ).run(scopeId, epoch, provider)
            compactReleased()
            assertCurrent()
            db.exec('COMMIT')
            closed = true
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
        }
      }
    }
  }
}
