import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { parseProjectTask } from './task-document'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { type DelegationContext, TaskDelegationPolicy } from './task-delegation-policy'
import { taskAdmission } from './task-authorization'
import { claimTaskSession, recordTaskSessionProgress } from './task-session-attempt'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
function setup() {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new TaskWorkflowStore(db)
  const task = {
    ...parseProjectTask(
      projectTaskTemplate({
        id: 'task-11111111-1111-4111-8111-111111111111',
        title: 'Synthetic delegated task'
      })
    ),
    source: 'project',
    path: 'docs/tasks/one/task.md'
  }
  const context: DelegationContext = {
    binding: {
      installationId: 'host',
      machineBinding: 'machine',
      projectId: 'project',
      root: '/synthetic',
      configRevision: 'c'.repeat(64)
    },
    actor: { key: 'director', aliases: ['director'] },
    runId: null
  }
  store.register('project', '/synthetic', task)
  const proposal = (grant = true) =>
    store.transaction(() =>
      store.delegation.propose(
        'project',
        'paired-phone',
        'connection',
        store.delegation.read('project').generation,
        grant
          ? {
              schema: 1,
              binding: context.binding,
              actor: context.actor,
              actorAddress: 'synthetic-director',
              actions: ['approve-plan', 'accept-result', 'send-to-integration', 'request-changes'],
              runId: null,
              taskIds: null,
              expiresAt: Date.now() + 60_000,
              generation: store.delegation.read('project').generation + 1
            }
          : null,
        context.binding
      )
    )
  const install = (grant = true) => {
    const proposed = proposal(grant)
    return store.transaction(() =>
      store.delegation.confirm(
        'project',
        'paired-phone',
        'connection',
        proposed.id,
        proposed.digest,
        randomUUID(),
        context.binding
      )
    )
  }
  const approve = () =>
    store.transaction(() => store.delegation.approve(context, task, randomUUID()))
  return { db, store, task, context, proposal, install, approve }
}
it('registers an empty project before reviewing a scoped grant', () => {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new TaskWorkflowStore(db)
  const binding = {
    installationId: 'host',
    machineBinding: 'machine',
    projectId: 'empty-project',
    root: '/synthetic-empty',
    configRevision: 'c'.repeat(64)
  }
  store.syncGraph(binding.projectId, binding.root, [])
  const proposed = store.transaction(() =>
    store.delegation.propose(
      binding.projectId,
      'interactive:owner',
      'connection',
      0,
      {
        schema: 1,
        binding,
        actor: { key: 'grantee', aliases: ['grantee'] },
        actorAddress: 'synthetic-grantee',
        actions: ['approve-plan'],
        runId: null,
        taskIds: null,
        expiresAt: Date.now() + 60_000,
        generation: 1
      },
      binding
    )
  )
  expect(proposed.grant?.binding.projectId).toBe(binding.projectId)
  expect(store.delegation.read(binding.projectId).generation).toBe(0)
  store.transaction(() =>
    store.delegation.confirm(
      binding.projectId,
      'interactive:owner',
      'connection',
      proposed.id,
      proposed.digest,
      randomUUID(),
      binding
    )
  )
  expect(store.delegation.read(binding.projectId).generation).toBe(1)
  expect(() => store.syncGraph(binding.projectId, '/another-root', [])).toThrow(/another root/)
})
it('defaults to manual, records explicit grant and delegated actor without manufacturing manual approval', () => {
  const { store, task, context, install, approve } = setup()
  expect(taskAdmission(store, 'project', task, context)).toBeNull()
  install()
  approve()
  expect(store.item('project', task.id).approved_revision).toBeNull()
  expect(taskAdmission(store, 'project', task, context)?.source).toBe('delegated')
  expect(() => store.requireReady('project', task, [])).toThrow(/Approve/)
  expect(() => store.requireReady('project', task, [], context)).not.toThrow()
  const audit = store.native.db
    .prepare('SELECT actor,receipt_json FROM project_task_delegation_audit WHERE operation=?')
    .get('plan.approveDelegated')
  expect(audit?.actor).toBe('director')
  expect(audit?.receipt_json).not.toContain('interactive operator')
})
it('pins proposal to issuer, connection, digest, scope and generation', () => {
  const { store, context, proposal, install } = setup()
  const p = proposal()
  const confirm = (issuer: string, connection: string, digest: string) =>
    store.transaction(() =>
      store.delegation.confirm(
        'project',
        issuer,
        connection,
        p.id,
        digest,
        randomUUID(),
        context.binding
      )
    )
  expect(() => confirm('another-device', 'connection', p.digest)).toThrow(/connection/)
  expect(() => confirm('paired-phone', 'other-connection', p.digest)).toThrow(/connection/)
  expect(() => confirm('paired-phone', 'connection', '0'.repeat(64))).toThrow(/connection/)
  install()
  expect(() => confirm('paired-phone', 'connection', p.digest)).toThrow(/generation/)
})
it('preserves an unchanged valid grant across capable store restart, but refuses changed host/root/config/actor/Run', () => {
  const { store, task, context, install, approve } = setup()
  install()
  approve()
  const restarted = new TaskWorkflowStore(store.native)
  expect(taskAdmission(restarted, 'project', task, context)?.source).toBe('delegated')
  for (const binding of [
    { ...context.binding, installationId: 'other' },
    { ...context.binding, machineBinding: 'other' },
    { ...context.binding, root: '/other' },
    { ...context.binding, configRevision: 'f'.repeat(64) },
    { ...context.binding, projectId: 'other' }
  ]) {
    expect(taskAdmission(restarted, 'project', task, { ...context, binding })).toBeNull()
  }
  expect(
    taskAdmission(restarted, 'project', task, {
      ...context,
      actor: { key: 'other', aliases: ['other'] }
    })
  ).toBeNull()
})
it('allows future in-project cards while exact revision approval, optional narrowing, action and Run still fence admission', () => {
  const { store, task, context, install, approve } = setup()
  install()
  approve()
  const future = { ...task, id: 'task-22222222-2222-4222-8222-222222222222' }
  store.register('project', '/synthetic', future)
  expect(taskAdmission(store, 'project', future, context)).toBeNull()
  store.transaction(() => store.delegation.approve(context, future, randomUUID()))
  expect(taskAdmission(store, 'project', future, context)?.source).toBe('delegated')
  const grant = store.delegation.read('project').grant
  if (!grant) {
    throw new Error('Fixture grant missing')
  }
  const p = store.transaction(() =>
    store.delegation.propose(
      'project',
      'paired-phone',
      'connection',
      1,
      {
        ...grant,
        generation: 2,
        taskIds: [task.id],
        runId: 'exact-run',
        actions: ['approve-plan']
      },
      context.binding
    )
  )
  store.transaction(() =>
    store.delegation.confirm(
      'project',
      'paired-phone',
      'connection',
      p.id,
      p.digest,
      randomUUID(),
      context.binding
    )
  )
  expect(() => store.delegation.require(context, task.id, 'approve-plan')).toThrow(/scope/)
  expect(() =>
    store.delegation.require({ ...context, runId: 'exact-run' }, future.id, 'approve-plan')
  ).toThrow(/scope/)
  expect(() =>
    store.delegation.require({ ...context, runId: 'exact-run' }, task.id, 'accept-result')
  ).toThrow(/scope/)
})
it('revocation fences new admission but preserves exact reserved-owner progress/completion and blocks new ownership', () => {
  const { store, task, context, install, approve } = setup()
  install()
  approve()
  const attempt = claimTaskSession(
    store,
    'project',
    task,
    'run_legacy_local',
    'owner',
    [],
    null,
    context
  )
  install(false)
  expect(taskAdmission(store, 'project', task, context)).toBeNull()
  const progress = () =>
    recordTaskSessionProgress(
      store,
      'project',
      task,
      attempt.id,
      'owner',
      { checkpointPath: 'checkpoint.md', blocker: null },
      context
    )
  expect(progress).not.toThrow()
  expect(() =>
    claimTaskSession(store, 'project', task, 'run_legacy_local', 'other', [], null, context)
  ).toThrow(/another chat/)
  expect(() =>
    recordTaskSessionProgress(
      store,
      'project',
      task,
      attempt.id,
      'owner',
      {
        checkpointPath: 'checkpoint.md',
        blocker: null,
        reportPath: 'report.md',
        resultHash: 'hash',
        reportText: 'Synthetic non-code report'
      },
      context
    )
  ).not.toThrow()
  expect(store.item('project', task.id).phase).toBe('review')
  expect(store.native.db.prepare('SELECT COUNT(*) AS n FROM project_task_results').get()?.n).toBe(1)
})
it('permits explicit owner release at observed changed plan revision, leaving it draft after revoke', () => {
  const { store, task, context, install, approve } = setup()
  install()
  approve()
  const attempt = claimTaskSession(
    store,
    'project',
    task,
    'run_legacy_local',
    'owner',
    [],
    null,
    context
  )
  install(false)
  const changed = { ...task, revision: 'f'.repeat(64) }
  store.register('project', '/synthetic', changed)
  const save = (release: boolean) =>
    recordTaskSessionProgress(
      store,
      'project',
      changed,
      attempt.id,
      'owner',
      { checkpointPath: 'checkpoint.md', blocker: null, release },
      context
    )
  expect(() => save(false)).toThrow(/plan changed/)
  expect(() => save(true)).not.toThrow()
  expect(store.item('project', task.id).phase).toBe('draft')
})
it('replays committed receipt after revoke without restoring eligibility and rejects changed actor or payload', () => {
  const { store, task, context, install } = setup()
  install()
  const id = randomUUID()
  const first = store.transaction(() => store.delegation.approve(context, task, id))
  install(false)
  const replay = store.transaction(() => store.delegation.approve(context, task, id))
  expect(replay).toEqual({ ...first, replayed: true })
  expect(taskAdmission(store, 'project', task, context)).toBeNull()
  expect(() =>
    store.transaction(() =>
      store.delegation.approve(
        { ...context, actor: { key: 'other', aliases: ['other'] } },
        task,
        id
      )
    )
  ).toThrow(/replay conflicts/)
  expect(() =>
    store.transaction(() =>
      store.delegation.approve(context, { ...task, revision: 'f'.repeat(64) }, id)
    )
  ).toThrow(/replay conflicts/)
})
it('rolls back approval if structured audit fails and denies expired grants without creating native tasks', () => {
  const { store, task, context, install, approve } = setup()
  install()
  store.native.db.exec(
    "CREATE TRIGGER fail_delegation_audit BEFORE INSERT ON project_task_delegation_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"
  )
  expect(approve).toThrow(/audit unavailable/)
  expect(store.item('project', task.id).phase).toBe('draft')
  expect(
    store.native.db.prepare('SELECT COUNT(*) AS n FROM project_task_delegated_plans').get()?.n
  ).toBe(0)
  const expired = new TaskDelegationPolicy(store, () => Date.now() + 120_000)
  expect(() => expired.require(context, task.id, 'approve-plan')).toThrow(/expired/)
  expect(store.native.db.prepare('SELECT COUNT(*) AS n FROM project_task_attempts').get()?.n).toBe(
    0
  )
})
