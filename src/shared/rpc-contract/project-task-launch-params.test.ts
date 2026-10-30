import { expect, it } from 'vitest'
import { ProjectTaskStart } from './project-task-workflow-params'
import { WorkerStartParams } from './orchestration-worker-start-params'

const placement = { from: 'coordinator', worktree: 'new-child', repo: 'web', agent: 'codex' }
const card = {
  worktree: 'folder:project',
  id: 'task-example',
  revision: 'a'.repeat(64),
  expectedExecutionHostId: 'local'
}

it('uses the approved card as the task source without a dummy worker spec', () => {
  const parsed = ProjectTaskStart.parse({ ...card, launch: placement })
  expect(parsed.launch).toEqual(placement)
  expect(WorkerStartParams.safeParse(placement).success).toBe(false)
})

it.each([{ spec: 'legacy placeholder' }, { task: 'legacy-task' }])(
  'accepts older card clients supplying a task source',
  (source) => {
    expect(
      ProjectTaskStart.safeParse({ ...card, launch: { ...placement, ...source } }).success
    ).toBe(true)
    expect(WorkerStartParams.safeParse({ ...placement, ...source }).success).toBe(true)
  }
)

it('keeps normal worker source and model validation unchanged', () => {
  expect(WorkerStartParams.safeParse({ ...placement, task: 'one', spec: 'two' }).success).toBe(
    false
  )
  expect(
    ProjectTaskStart.safeParse({ ...card, launch: { ...placement, model: ' invalid ' } }).success
  ).toBe(false)
})
