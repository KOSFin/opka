import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { createClaudeNativePoolScopeRegistry } from './claude-native-pool-scope-registry'
import { beginNativeAccountPoolEpoch } from './orchestration/db/account-pool-native-fences'
import { NativeCliControlError } from '../../shared/native-cli-control-error'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'opka-claude-scopes-'))
  const db = new OrchestrationDb(':memory:')
  cleanups.push(() => {
    db.close()
    rmSync(dataRoot, { recursive: true, force: true })
  })
  const sources = { assertOwned: vi.fn(), assertWriterIdle: vi.fn() }
  return {
    dataRoot,
    db,
    sources,
    registry: createClaudeNativePoolScopeRegistry({ dataRoot, db, sources })
  }
}
it('initializes once under actual source proof and reuses its epoch for every launch', () => {
  const f = fixture()
  const first = f.registry.registerScope()
  const epoch = f.db.db
    .prepare("SELECT epoch FROM account_pool_native_epochs WHERE provider='claude'")
    .get()
  const proofs = f.sources.assertWriterIdle.mock.calls.length
  const second = f.registry.registerScope()
  expect(f.sources.assertWriterIdle).toHaveBeenCalledTimes(proofs)
  expect(
    f.db.db.prepare("SELECT epoch FROM account_pool_native_epochs WHERE provider='claude'").get()
  ).toEqual(epoch)
  expect(
    f.db.db.prepare('SELECT COUNT(*) AS n FROM account_pool_native_scopes').get()
  ).toMatchObject({ n: 2 })
  first.close()
  second.close()
})
it('refuses a retained facade without reading or deleting its credentials', () => {
  const f = fixture()
  const retained = join(f.dataRoot, 'native-cli-sessions', 'claude-profiles', 'retained')
  mkdirSync(retained, { recursive: true })
  expect(() => f.registry.registerScope()).toThrow(NativeCliControlError)
  expect(
    f.db.db.prepare('SELECT COUNT(*) AS n FROM account_pool_native_scopes').get()
  ).toMatchObject({ n: 0 })
})
it('refuses outstanding native writer proof and never invokes a Codex recovery shortcut', () => {
  const f = fixture()
  const codex = beginNativeAccountPoolEpoch(f.db.db, {
    assertExclusive() {},
    assertWriterIdle() {}
  })
  const live = codex.registerScope()
  f.sources.assertWriterIdle.mockImplementation(() => {
    throw new Error('writer is unverifiable')
  })
  expect(() => f.registry.registerScope()).toThrow('writer is unverifiable')
  expect(f.db.db.prepare('SELECT provider FROM account_pool_native_scopes').all()).toEqual([
    { provider: 'codex' }
  ])
  live.close()
})
it('refuses legacy native assignments and preserves their recovery evidence', () => {
  const f = fixture()
  f.db.db
    .prepare(`INSERT INTO account_pool_assignments
    (owner_key,provider,pool_id,policy_revision,account_id,quota_identity)
    VALUES('native-cli:old','claude','pool',1,'account','quota')`)
    .run()
  expect(() => f.registry.registerScope()).toThrow(NativeCliControlError)
  expect(f.db.db.prepare('SELECT released_at FROM account_pool_assignments').get()).toMatchObject({
    released_at: null
  })
})

it('attaches after a normal host restart while leaving old scope, active assignment and facade untouched', () => {
  const f = fixture()
  const old = f.registry.registerScope()
  f.db.db.exec('BEGIN IMMEDIATE')
  const oldKey = old.nextOwnerKey()
  f.db.db
    .prepare(`INSERT INTO account_pool_assignments(owner_key,provider,pool_id,policy_revision,account_id,quota_identity)
    VALUES(?,'claude','pool',1,'retained-account','retained-quota')`)
    .run(oldKey)
  f.db.db.exec('COMMIT')
  const retained = join(f.dataRoot, 'native-cli-sessions', 'claude-profiles', randomUUID())
  mkdirSync(retained, { recursive: true })
  const marker = join(retained, 'synthetic-owned-marker')
  writeFileSync(marker, 'retain unchanged')
  const beforeEpoch = f.db.db
    .prepare("SELECT * FROM account_pool_native_epochs WHERE provider='claude'")
    .get()
  const beforeAssignment = f.db.db
    .prepare('SELECT * FROM account_pool_assignments WHERE owner_key=?')
    .get(oldKey)
  f.sources.assertOwned.mockImplementation(() => {
    throw new Error('old profile owner')
  })
  const freshSources = { assertOwned: vi.fn(), assertWriterIdle: vi.fn() }
  const restarted = createClaudeNativePoolScopeRegistry({ ...f, sources: freshSources })
  const fresh = restarted.registerScope()
  expect(
    f.db.db.prepare("SELECT * FROM account_pool_native_epochs WHERE provider='claude'").get()
  ).toEqual(beforeEpoch)
  expect(
    f.db.db.prepare('SELECT * FROM account_pool_assignments WHERE owner_key=?').get(oldKey)
  ).toEqual(beforeAssignment)
  expect(f.db.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()).toEqual(
    { count: 2 }
  )
  f.db.db.exec('BEGIN IMMEDIATE')
  const freshKey = fresh.nextOwnerKey()
  f.db.db.exec('COMMIT')
  expect(freshKey).not.toBe(oldKey)
  expect(() => old.close()).toThrow(/old profile owner/)
  fresh.close()
  expect(readFileSync(marker, 'utf8')).toBe('retain unchanged')
  expect(
    f.db.db.prepare('SELECT * FROM account_pool_assignments WHERE owner_key=?').get(oldKey)
  ).toEqual(beforeAssignment)
  expect(f.db.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()).toEqual(
    { count: 1 }
  )
  expect(freshSources.assertWriterIdle).toHaveBeenCalled()
})
it('counts unknown retained facade names toward128 without reading or removing them', () => {
  const f = fixture()
  for (let index = 0; index < 128; index++) {
    mkdirSync(join(f.dataRoot, 'native-cli-sessions', 'claude-profiles', `unknown-${index}`), {
      recursive: true
    })
  }
  expect(() => f.registry.registerScope()).toThrow(/capacity/)
  expect(f.db.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()).toEqual(
    { count: 0 }
  )
})
it('does not attach retained work while the current source writer is unverifiable', () => {
  const f = fixture()
  f.registry.registerScope()
  const before = f.db.db.prepare('SELECT * FROM account_pool_native_scopes').all()
  const restarted = createClaudeNativePoolScopeRegistry({
    ...f,
    sources: {
      assertOwned() {},
      assertWriterIdle() {
        throw new Error('source writer unverifiable')
      }
    }
  })
  expect(() => restarted.registerScope()).toThrow(/source writer unverifiable/)
  expect(f.db.db.prepare('SELECT * FROM account_pool_native_scopes').all()).toEqual(before)
})
it('refuses cross-provider retained metadata before bootstrapping a missing Claude epoch', () => {
  const f = fixture()
  const key = `native-scope-v2:codex:1:${randomUUID()}:1`
  f.db.db
    .prepare(`INSERT INTO account_pool_assignments(owner_key,provider,pool_id,policy_revision,account_id,quota_identity)
    VALUES(?,'claude','pool',1,'x','x')`)
    .run(key)
  const before = f.db.db.prepare('SELECT * FROM account_pool_assignments').all()
  expect(() => f.registry.registerScope()).toThrow(NativeCliControlError)
  expect(
    f.db.db.prepare("SELECT epoch FROM account_pool_native_epochs WHERE provider='claude'").get()
  ).toBeUndefined()
  expect(f.db.db.prepare('SELECT * FROM account_pool_assignments').all()).toEqual(before)
})
