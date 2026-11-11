import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { parseProjectTask } from './task-document'
import { projectTaskTemplate } from '../../shared/project-task-template'
import type { DelegationContext } from './task-delegation-policy'
import { claimTaskSession, recordTaskSessionProgress } from './task-session-attempt'

export function taskResultFixture(path = ':memory:') {
  const db = new OrchestrationDb(path)
  const store = new TaskWorkflowStore(db)
  const binding = {
    installationId: 'host',
    machineBinding: 'machine',
    projectId: 'project',
    root: '/synthetic',
    configRevision: 'c'.repeat(64)
  }
  const actor = (key: string): DelegationContext => ({
    binding,
    actor: { key, aliases: [key] },
    runId: null
  })
  const director = actor('director')
  const implementer = actor('implementer')
  const reviewer = actor('reviewer')
  const task = {
    ...parseProjectTask(
      projectTaskTemplate({
        id: 'task-11111111-1111-4111-8111-111111111111',
        title: 'Synthetic document'
      }).replace('kind: implementation', 'kind: documentation')
    ),
    source: 'project',
    path: 'docs/tasks/one/task.md'
  }
  const reviewTask = {
    ...task,
    id: 'task-22222222-2222-4222-8222-222222222222',
    kind: 'review' as const,
    path: 'docs/tasks/review/task.md'
  }
  store.register('project', '/synthetic', task)
  store.register('project', '/synthetic', reviewTask)
  store.approve('project', reviewTask)
  const proposal = store.transaction(() =>
    store.delegation.propose(
      'project',
      'interactive-device',
      'connection',
      0,
      {
        schema: 1,
        binding,
        actor: implementer.actor,
        actorAddress: 'implementer',
        actions: ['approve-plan', 'accept-result', 'request-changes', 'send-to-integration'],
        runId: null,
        taskIds: null,
        expiresAt: Date.now() + 60_000,
        generation: 1
      },
      binding
    )
  )
  store.transaction(() =>
    store.delegation.confirm(
      'project',
      'interactive-device',
      'connection',
      proposal.id,
      proposal.digest,
      randomUUID(),
      binding
    )
  )
  store.transaction(() => store.delegation.approve(implementer, task, randomUUID()))
  const implementation = claimTaskSession(
    store,
    'project',
    task,
    'run_legacy_local',
    'impl-owner',
    [],
    null,
    implementer
  )
  const directorProposal = store.transaction(() =>
    store.delegation.propose(
      'project',
      'interactive-device',
      'connection',
      1,
      {
        schema: 1,
        binding,
        actor: director.actor,
        actorAddress: 'director',
        actions: ['approve-plan', 'accept-result', 'request-changes', 'send-to-integration'],
        runId: null,
        taskIds: null,
        expiresAt: Date.now() + 60_000,
        generation: 2
      },
      binding
    )
  )
  store.transaction(() =>
    store.delegation.confirm(
      'project',
      'interactive-device',
      'connection',
      directorProposal.id,
      directorProposal.digest,
      randomUUID(),
      binding
    )
  )
  const review = claimTaskSession(
    store,
    'project',
    reviewTask,
    'run_legacy_local',
    'review-owner',
    [],
    null,
    reviewer
  )
  const completeImplementation = () =>
    recordTaskSessionProgress(
      store,
      'project',
      task,
      implementation.id,
      'impl-owner',
      {
        checkpointPath: 'checkpoint.md',
        blocker: null,
        reportPath: 'report.md',
        resultHash: 'impl-hash',
        reportText: 'Exact implementation report'
      },
      implementer
    )
  const completeReview = () =>
    recordTaskSessionProgress(
      store,
      'project',
      reviewTask,
      review.id,
      'review-owner',
      {
        checkpointPath: 'review-checkpoint.md',
        blocker: null,
        reportPath: 'review.md',
        resultHash: 'review-hash',
        reportText: 'Exact independent review'
      },
      reviewer
    )
  const resultDigest = () => {
    const row = db.db
      .prepare(
        'SELECT digest FROM project_task_results WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(implementation.id)
    if (typeof row?.digest !== 'string') {
      throw new Error('Fixture result missing')
    }
    return row.digest
  }
  return {
    db,
    store,
    binding,
    director,
    implementer,
    reviewer,
    task,
    reviewTask,
    implementation,
    review,
    completeImplementation,
    completeReview,
    resultDigest
  }
}
