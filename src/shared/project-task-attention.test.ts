import { expect, it } from 'vitest'
import type { ProjectTaskWorkflow } from './project-task-workflow'
import { projectTaskNeedsDecision } from './project-task-attention'

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
