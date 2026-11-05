import { z } from 'zod'
import type Database from '../../../sqlite/sync-database'
import {
  createNativeAccountPoolScopeRegistry,
  NATIVE_POOL_SCOPE_PREFIX as PREFIX,
  NativePoolCounter as Counter,
  NativePoolProvider as Provider,
  NativePoolEpochRow as EpochRow,
  NativePoolScopeRow as ScopeRow,
  type NativeAccountPoolProvider
} from './account-pool-native-scope'
export type { NativeAccountPoolProvider, NativeAccountPoolScope } from './account-pool-native-scope'

const Owner = /^native-scope-v2:(codex|claude):([1-9]\d*):([a-f0-9-]{36}):([1-9]\d*)$/
export const NATIVE_ACCOUNT_POOL_FENCES_SQL = `
CREATE TABLE IF NOT EXISTS account_pool_native_epochs (
  provider TEXT PRIMARY KEY CHECK(provider IN ('codex','claude')), epoch INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_pool_native_scopes (
  scope_id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('codex','claude')), epoch INTEGER NOT NULL, generation INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_pool_native_released_v2 ON account_pool_assignments(sequence)
WHERE released_at IS NOT NULL AND owner_key >= 'native-scope-v2:' AND owner_key < 'native-scope-v2;';
CREATE INDEX IF NOT EXISTS account_pool_native_active_scope_v2 ON account_pool_assignments(owner_key)
WHERE released_at IS NULL AND owner_key >= 'native-scope-v2:' AND owner_key < 'native-scope-v2;';
`

export function validateNativeAccountPoolOwner(
  db: Database.Database,
  ownerKey: string,
  provider: NativeAccountPoolProvider
): void {
  if (ownerKey.startsWith('native-scope-v1:')) {
    throw new Error('Unsupported native assignment fence requires explicit recovery')
  }
  if (!ownerKey.startsWith(PREFIX)) {
    return
  }
  const match = Owner.exec(ownerKey)
  if (!match) {
    throw new Error('Native account assignment owner is invalid')
  }
  if (match[1] !== provider) {
    throw new Error('Native account assignment provider mismatch')
  }
  const epoch = Counter.parse(Number(match[2]))
  const generation = Counter.parse(Number(match[4]))
  const current = EpochRow.parse(
    db.prepare('SELECT epoch FROM account_pool_native_epochs WHERE provider=?').get(provider)
  )
  const scope = ScopeRow.safeParse(
    db
      .prepare('SELECT provider,epoch,generation FROM account_pool_native_scopes WHERE scope_id=?')
      .get(match[3])
  )
  if (
    !scope.success ||
    match[1] !== provider ||
    scope.data.provider !== provider ||
    current.epoch !== epoch ||
    scope.data.epoch !== epoch ||
    scope.data.generation !== generation
  ) {
    throw new Error('Native account assignment owner is stale or revoked')
  }
}

/** Keep the selector's exact MAX(sequence), all active rows and every legacy replay fence. */
export function compactReleasedNativeAccountPoolRows(db: Database.Database): void {
  db.prepare(`DELETE FROM account_pool_assignments WHERE sequence IN (
    SELECT a.sequence FROM account_pool_assignments a INDEXED BY account_pool_native_released_v2
    WHERE a.released_at IS NOT NULL AND a.owner_key >= 'native-scope-v2:' AND a.owner_key < 'native-scope-v2;'
    AND EXISTS (SELECT 1 FROM account_pool_assignments newer
      WHERE newer.provider=a.provider AND newer.quota_identity=a.quota_identity AND newer.sequence>a.sequence)
    AND NOT EXISTS (SELECT 1 FROM account_pool_pty_bindings b WHERE b.owner_key=a.owner_key)
    AND NOT EXISTS (SELECT 1 FROM account_pool_replacement_claims r WHERE r.owner_key=a.owner_key OR r.replaces_owner_key=a.owner_key)
    ORDER BY a.sequence LIMIT 256
  )`).run()
}

export function readNativeAccountPoolPartition(
  db: Database.Database,
  provider: NativeAccountPoolProvider
) {
  const epoch = db
    .prepare('SELECT epoch FROM account_pool_native_epochs WHERE provider=?')
    .get(provider)
  const count = (value: unknown) =>
    z.object({ count: z.number().int().nonnegative() }).parse(value).count
  return {
    epoch: epoch ? EpochRow.parse(epoch).epoch : null,
    scopes: count(
      db
        .prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes WHERE provider=?')
        .get(provider)
    ),
    activeAssignments: count(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM account_pool_assignments
          INDEXED BY account_pool_native_active_scope_v2
          WHERE released_at IS NULL AND owner_key >= 'native-scope-v2:' AND owner_key < 'native-scope-v2;'
          AND (provider=? OR (owner_key>=? AND owner_key<?))`
        )
        .get(provider, `${PREFIX}${provider}:`, `${PREFIX}${provider};`)
    )
  }
}

/** A new profile owner may revoke old capabilities only after the old writer is proven idle. */
export function beginNativeAccountPoolEpoch(
  db: Database.Database,
  proof: {
    assertExclusive: () => void
    assertWriterIdle: () => void
  },
  provider: NativeAccountPoolProvider = 'codex'
) {
  assertNativeFenceShape(db)
  const partition = `${PREFIX}${provider}:`
  const partitionEnd = `${PREFIX}${provider};`
  proof.assertExclusive()
  proof.assertWriterIdle()
  db.exec('BEGIN IMMEDIATE')
  let epoch: number
  try {
    const previous = db
      .prepare('SELECT epoch FROM account_pool_native_epochs WHERE provider=?')
      .get(provider)
    epoch = Counter.parse(previous ? EpochRow.parse(previous).epoch + 1 : 1)
    const active = db
      .prepare(
        `SELECT owner_key,provider FROM account_pool_assignments
        INDEXED BY account_pool_native_active_scope_v2
        WHERE released_at IS NULL AND owner_key >= 'native-scope-v2:' AND owner_key < 'native-scope-v2;'
        AND (provider=? OR (owner_key>=? AND owner_key<?)) LIMIT 65`
      )
      .all(provider, partition, partitionEnd)
    if (active.length > 64 || active.some((row) => !Owner.test(String(row.owner_key)))) {
      throw new Error('Native assignment recovery inventory is unverifiable')
    }
    if (
      provider === 'claude' &&
      (active.length ||
        db
          .prepare('SELECT scope_id FROM account_pool_native_scopes WHERE provider=? LIMIT 1')
          .get(provider))
    ) {
      throw new Error('Claude native assignment scopes require explicit prior-process recovery')
    }
    for (const row of active) {
      if (Provider.parse(row.provider) !== provider) {
        throw new Error('Native assignment recovery provider is unverifiable')
      }
      validateNativeAccountPoolOwner(db, String(row.owner_key), provider)
    }
    db.prepare(
      "UPDATE account_pool_assignments SET released_at=datetime('now') WHERE owner_key>=? AND owner_key<? AND released_at IS NULL"
    ).run(partition, partitionEnd)
    db.prepare('DELETE FROM account_pool_native_scopes WHERE provider=?').run(provider)
    db.prepare(
      'INSERT INTO account_pool_native_epochs(provider,epoch) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET epoch=excluded.epoch'
    ).run(provider, epoch)
    compactReleasedNativeAccountPoolRows(db)
    proof.assertExclusive()
    proof.assertWriterIdle()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return createNativeAccountPoolScopeRegistry(db, proof, provider, epoch, () =>
    compactReleasedNativeAccountPoolRows(db)
  )
}

function assertNativeFenceShape(db: Database.Database): void {
  const shape = (table: 'account_pool_native_scopes' | 'account_pool_native_epochs') =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => [row.name, String(row.type).toUpperCase(), row.notnull, row.pk, row.dflt_value])
  const scopes = JSON.stringify(shape('account_pool_native_scopes'))
  const epochs = JSON.stringify(shape('account_pool_native_epochs'))
  const expectedScopes = JSON.stringify([
    ['scope_id', 'TEXT', 0, 1, null],
    ['provider', 'TEXT', 1, 0, null],
    ['epoch', 'INTEGER', 1, 0, null],
    ['generation', 'INTEGER', 1, 0, null]
  ])
  const expectedEpochs = JSON.stringify([
    ['provider', 'TEXT', 0, 1, null],
    ['epoch', 'INTEGER', 1, 0, null]
  ])
  const old = db
    .prepare(
      'SELECT owner_key FROM account_pool_assignments WHERE owner_key>=? AND owner_key<? LIMIT 1'
    )
    .get('native-scope-v1:', 'native-scope-v1;')
  if (scopes !== expectedScopes || epochs !== expectedEpochs || old) {
    throw new Error('Unsupported native assignment fence requires explicit recovery')
  }
}

/** Retain old Claude resources; this grants only fresh scopes under the current host proof. */
export function attachClaudeNativeAccountPoolEpoch(
  db: Database.Database,
  proof: { assertExclusive: () => void; assertWriterIdle: () => void }
) {
  assertNativeFenceShape(db)
  proof.assertExclusive()
  proof.assertWriterIdle()
  db.exec('BEGIN IMMEDIATE')
  let epoch: number
  try {
    const current = db
      .prepare("SELECT epoch FROM account_pool_native_epochs WHERE provider='claude'")
      .get()
    if (!current) {
      throw new Error('Claude native assignment epoch requires explicit recovery')
    }
    epoch = Counter.positive().parse(EpochRow.parse(current).epoch)
    if (
      db
        .prepare(`SELECT 1 FROM account_pool_assignments WHERE provider='claude'
      AND released_at IS NULL AND owner_key >= 'native-cli:' AND owner_key < 'native-cli;' LIMIT 1`)
        .get()
    ) {
      throw new Error('Legacy Claude native assignments require explicit recovery')
    }
    const retained = db
      .prepare(
        "SELECT scope_id,provider,epoch,generation FROM account_pool_native_scopes WHERE provider='claude' LIMIT 65"
      )
      .all()
    if (retained.length > 64) {
      throw new Error('Claude native scope inventory requires explicit recovery')
    }
    const scopes = new Map(
      retained.map((row) => {
        const scope = ScopeRow.parse(row)
        if (scope.epoch !== epoch) {
          throw new Error('Claude native scope epoch requires explicit recovery')
        }
        return [z.uuid().parse(row.scope_id), scope]
      })
    )
    const active = db
      .prepare(`SELECT owner_key,provider FROM account_pool_assignments
      INDEXED BY account_pool_native_active_scope_v2
      WHERE released_at IS NULL AND owner_key >= 'native-scope-v2:' AND owner_key < 'native-scope-v2;'
      AND (provider='claude' OR (owner_key >= 'native-scope-v2:claude:' AND owner_key < 'native-scope-v2:claude;')) LIMIT 129`)
      .all()
    if (active.length > 128) {
      throw new Error('Claude native assignment inventory requires explicit recovery')
    }
    const counts = new Map<string, number>()
    for (const row of active) {
      const match = Owner.exec(String(row.owner_key))
      const scope = match ? scopes.get(match[3]) : undefined
      if (
        !match ||
        match[1] !== 'claude' ||
        row.provider !== 'claude' ||
        Counter.parse(Number(match[2])) !== epoch ||
        !scope ||
        Counter.parse(Number(match[4])) > scope.generation
      ) {
        throw new Error('Claude native assignment scope requires explicit recovery')
      }
      const count = (counts.get(match[3]) ?? 0) + 1
      if (count > 2) {
        throw new Error('Claude native scope retained-work surplus requires explicit recovery')
      }
      counts.set(match[3], count)
    }
    proof.assertExclusive()
    proof.assertWriterIdle()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return createNativeAccountPoolScopeRegistry(db, proof, 'claude', epoch, () =>
    compactReleasedNativeAccountPoolRows(db)
  )
}
