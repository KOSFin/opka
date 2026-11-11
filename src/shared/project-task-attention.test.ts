import { expect, it } from 'vitest'
import type { ProjectTaskAttempt, ProjectTaskWorkflow } from './project-task-workflow'
import { projectTaskNeedsDecision, projectTaskNextAction } from './project-task-attention'

const ready: ProjectTaskWorkflow = {
  taskId: 'fixture',
  phase: 'ready',
  archived: false,
  approvedRevision: 'revision',
  revisionChanged: false,
  attempts: [],
  events: [],
  exportError: null,
  recordedSequence: 0
}
it('keeps stale approval, failed export and unknown attempts in operator attention without guessing liveness', () => {
  expect(projectTaskNeedsDecision(ready)).toBe(false)
  expect(projectTaskNeedsDecision({ ...ready, revisionChanged: true })).toBe(true)
  expect(projectTaskNeedsDecision({ ...ready, phase: 'active' })).toBe(false)
  expect(projectTaskNeedsDecision({ ...ready, exportError: 'pending recovery' })).toBe(true)
  expect(projectTaskNeedsDecision({ ...ready, phase: 'review' })).toBe(true)
  expect(projectTaskNeedsDecision({ ...ready, archived: true, phase: 'review' })).toBe(false)
})

it('uses a session task blocker rather than the absence of a managed-worker receipt', () => {
  const attempt: ProjectTaskAttempt = {
    id: 'attempt',
    nativeTaskId: 'task',
    runId: 'run',
    revision: 'revision',
    createdAt: 'now',
    dispatchId: null,
    nativeStatus: 'ready',
    workerState: null,
    terminal: null,
    session: { checkpointPath: null, reportPath: null, blocker: null }
  }
  const workflow: ProjectTaskWorkflow = { ...ready, phase: 'active', attempts: [attempt] }
  expect(projectTaskNeedsDecision(workflow)).toBe(false)
  expect(
    projectTaskNeedsDecision({ ...workflow, attempts: [{ ...attempt, nativeStatus: 'unknown' }] })
  ).toBe(true)
  expect(
    projectTaskNeedsDecision({
      ...workflow,
      attempts: [
        {
          ...attempt,
          session: {
            checkpointPath: 'checkpoint.md',
            reportPath: null,
            blocker: 'Needs API contract'
          }
        }
      ]
    })
  ).toBe(true)
  expect(
    projectTaskNeedsDecision({
      ...workflow,
      phase: 'ready',
      attempts: [
        {
          ...attempt,
          nativeStatus: 'failed',
          session: {
            checkpointPath: 'checkpoint.md',
            reportPath: null,
            blocker: null,
            released: true
          }
        }
      ]
    })
  ).toBe(false)
})

it('names the next operator step without treating an unknown attempt as exited', () => {
  expect(projectTaskNextAction({ ...ready, phase: 'draft' })).toBe('Review and approve the plan')
  expect(projectTaskNextAction({ ...ready, phase: 'review' })).toBe(
    'Review the report and record a decision'
  )
  expect(projectTaskNextAction({ ...ready, revisionChanged: true })).toBe(
    'Review the changed plan before dispatching again'
  )
  expect(projectTaskNextAction({ ...ready, archived: true, phase: 'review' })).toBeNull()
  expect(
    projectTaskNextAction({
      ...ready,
      phase: 'active',
      attempts: [
        {
          nativeStatus: 'unknown',
          workerState: null
        }
      ]
    })
  ).toBe('Inspect the attempt and decide how to resume')
})
