import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { LEGACY_RUN_ID } from './orchestration/db/contract-constants'
import { readNativeStdioExternalReferences } from './native-stdio-external-references'
const stores: OrchestrationDb[] = []
const roots: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
const id = 'native_stdio_00000000-0000-4000-8000-000000000000'
function fixture() {
  const db = new OrchestrationDb(':memory:')
  stores.push(db)
  const read = () => readNativeStdioExternalReferences({ db, assertExclusive() {} }, id)
  return { db: db.db, read }
}
it('proves clear only for known schema and existing explicit reference columns', () => {
  const f = fixture()
  expect(f.read()).toBe('clear')
  f.db.prepare('UPDATE runs SET coordinator_orca_session_id=? WHERE id=?').run(id, LEGACY_RUN_ID)
  expect(f.read()).toBe('present')
})
it('preserves mail references without reading their body', () => {
  const f = fixture()
  f.db
    .prepare('INSERT INTO messages(id,from_handle,to_handle,subject,body) VALUES(?,?,?,?,?)')
    .run('own-message', `orca_session_id:${id}`, 'other', 'metadata', 'private-body-not-selected')
  expect(f.read()).toBe('present')
})
it('preserves worker resources and refuses late/unverifiable starts', () => {
  const f = fixture()
  f.db
    .prepare('INSERT INTO worker_dispatches(dispatch_id,state) VALUES(?,?)')
    .run('own-worker', 'start_unknown')
  expect(f.read()).toBe('unverifiable')
  f.db.prepare("UPDATE worker_dispatches SET state='succeeded'").run()
  expect(f.read()).toBe('clear')
  f.db
    .prepare(
      'INSERT INTO worker_terminal_resources(id,origin_dispatch_id,owner_dispatch_id,terminal_handle,process_incarnation) VALUES(?,?,?,?,?)'
    )
    .run('resource', 'own-worker', 'own-worker', 'structworker_unknown', `structured:${id}`)
  expect(f.read()).toBe('present')
})
it('does not treat unopened data or incompatible schema as absence', () => {
  expect(readNativeStdioExternalReferences({ db: null, assertExclusive() {} }, id)).toBe(
    'unverifiable'
  )
  const root = mkdtempSync(join(tmpdir(), 'opka-stdio-ref-'))
  roots.push(root)
  const databasePath = join(root, 'orchestration.db')
  const read = () =>
    readNativeStdioExternalReferences({ db: null, databasePath, assertExclusive() {} }, id)
  expect(read()).toBe('clear')
  writeFileSync(`${databasePath}-wal`, 'fake-owned-wal')
  expect(read()).toBe('unverifiable')
  const f = fixture()
  f.db.pragma('user_version=999')
  expect(f.read()).toBe('unverifiable')
})
it('refuses pending mutation and lost profile proof', () => {
  const f = fixture()
  f.db
    .prepare(
      'INSERT INTO mutation_receipts(caller_fingerprint,request_id,method,payload_hash,state) VALUES(?,?,?,?,?)'
    )
    .run('own', 'request', 'method', 'hash', 'pending')
  expect(f.read()).toBe('unverifiable')
  expect(
    readNativeStdioExternalReferences(
      {
        db: null,
        assertExclusive() {
          throw new Error('lost owner')
        }
      },
      id
    )
  ).toBe('unverifiable')
})
