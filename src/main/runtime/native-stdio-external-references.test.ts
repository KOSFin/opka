import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { LEGACY_RUN_ID } from './orchestration/db/contract-constants'
import { readNativeStdioExternalReferences } from './native-stdio-external-references'
import type { DelegationGrant } from '../../shared/project-task-delegation'
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
it('preserves active grant-only session references and ignores unrelated or expired grants', () => {
  const f = fixture()
  const projectId = 'synthetic-project'
  const now = Date.now()
  const grant = (actorAddress: string, expiresAt: number): DelegationGrant => ({
    schema: 1,
    binding: {
      installationId: 'synthetic-installation',
      machineBinding: 'synthetic-machine',
      projectId,
      root: '/synthetic',
      configRevision: 'a'.repeat(64)
    },
    actor: { key: 'synthetic-actor', aliases: ['synthetic-actor'] },
    actorAddress,
    actions: ['approve-plan'],
    runId: null,
    taskIds: null,
    expiresAt,
    generation: 1
  })
  f.db
    .prepare('INSERT INTO project_task_homes(project_id,root_path) VALUES(?,?)')
    .run(projectId, '/synthetic')
  f.db
    .prepare(
      'INSERT INTO project_task_delegation_policy(project_id,generation,grant_json) VALUES(?,?,?)'
    )
    .run(projectId, 1, JSON.stringify(grant('orca_session_id:other', now + 60_000)))
  expect(f.read()).toBe('clear')
  f.db
    .prepare('UPDATE project_task_delegation_policy SET grant_json=? WHERE project_id=?')
    .run(JSON.stringify(grant(`orca_session_id:${id}`, now + 60_000)), projectId)
  expect(f.read()).toBe('present')
  f.db
    .prepare('UPDATE project_task_delegation_policy SET grant_json=? WHERE project_id=?')
    .run(JSON.stringify(grant(`orca_session_id:${id}`, now - 1)), projectId)
  expect(f.read()).toBe('clear')
  f.db
    .prepare(
      'INSERT INTO project_task_delegation_proposals(id,project_id,issuer,connection_id,digest,grant_json,binding_json,generation,expires_at) VALUES(?,?,?,?,?,?,?,?,?)'
    )
    .run(
      'proposal',
      projectId,
      'synthetic-issuer',
      'synthetic-connection',
      'synthetic-digest',
      JSON.stringify(grant(`orca_session_id:${id}`, now + 60_000)),
      '{}',
      0,
      now + 30_000
    )
  expect(f.read()).toBe('present')
  f.db.prepare('UPDATE project_task_delegation_proposals SET expires_at=?').run(now - 1)
  expect(f.read()).toBe('clear')
})
it('refuses malformed active delegation metadata rather than proving absence', () => {
  const f = fixture()
  f.db
    .prepare('INSERT INTO project_task_homes(project_id,root_path) VALUES(?,?)')
    .run('synthetic-project', '/synthetic')
  f.db
    .prepare(
      'INSERT INTO project_task_delegation_policy(project_id,generation,grant_json) VALUES(?,?,?)'
    )
    .run('synthetic-project', 1, '{invalid-json')
  expect(f.read()).toBe('unverifiable')
})
it('bounds delegation rows and bytes while accepting a maximal valid grant', () => {
  const f = fixture()
  const now = Date.now()
  const grant: DelegationGrant = {
    schema: 1,
    binding: {
      installationId: 'synthetic-installation',
      machineBinding: 'synthetic-machine',
      projectId: 'synthetic-project',
      root: '\0'.repeat(4096),
      configRevision: 'a'.repeat(64)
    },
    actor: { key: 'synthetic-actor', aliases: Array(8).fill('\0'.repeat(256)) },
    actorAddress: '\0'.repeat(4096),
    actions: ['approve-plan', 'request-changes', 'send-to-integration', 'accept-result'],
    runId: null,
    taskIds: Array(1000).fill('\0'.repeat(256)),
    expiresAt: now + 60_000,
    generation: 1
  }
  f.db
    .prepare('INSERT INTO project_task_homes(project_id,root_path) VALUES(?,?)')
    .run('synthetic-project', '/synthetic')
  f.db
    .prepare(
      'INSERT INTO project_task_delegation_policy(project_id,generation,grant_json) VALUES(?,?,?)'
    )
    .run('synthetic-project', 1, JSON.stringify(grant))
  expect(f.read()).toBe('clear')
  f.db
    .prepare('UPDATE project_task_delegation_policy SET grant_json=?')
    .run('x'.repeat(2 * 1024 * 1024 + 1))
  expect(f.read()).toBe('unverifiable')
  f.db.prepare('UPDATE project_task_delegation_policy SET grant_json=?').run(JSON.stringify(grant))
  const addHome = f.db.prepare('INSERT INTO project_task_homes(project_id,root_path) VALUES(?,?)')
  const addPolicy = f.db.prepare(
    'INSERT INTO project_task_delegation_policy(project_id,generation,grant_json) VALUES(?,?,?)'
  )
  const shortGrant = JSON.stringify({
    ...grant,
    binding: { ...grant.binding, root: '/synthetic' },
    actorAddress: 'unrelated',
    taskIds: null
  })
  for (let index = 1; index <= 64; index += 1) {
    const projectId = `synthetic-project-${index}`
    addHome.run(projectId, `/synthetic/${index}`)
    addPolicy.run(projectId, 1, shortGrant)
  }
  expect(f.read()).toBe('unverifiable')
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
