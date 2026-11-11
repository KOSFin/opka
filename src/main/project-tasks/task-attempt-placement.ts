import { z } from 'zod'
import { TaskDelegationActor } from '../../shared/project-task-delegation'
import { delegationDigest } from './task-delegation-policy'
import { taskAttemptAuthor, taskAttemptDispatchId } from './task-result-authors'
import type { TaskWorkflowStore } from './task-workflow-store'

export const TaskAttemptPlacement = z
  .object({
    workspaceId: z.string().min(1).max(4096),
    executionHostId: z.literal('local'),
    worktreePath: z.string().min(1).max(4096),
    owner: TaskDelegationActor
  })
  .strict()
export type AttemptPlacement = z.infer<typeof TaskAttemptPlacement>

export function captureTaskSessionPlacement(
  store: TaskWorkflowStore,
  attemptId: string,
  placement: AttemptPlacement
): void {
  if (!store.native.db.isTransaction) {
    throw new Error('Attempt placement requires the workflow writer')
  }
  const evidence = TaskAttemptPlacement.parse(placement)
  if (delegationDigest(taskAttemptAuthor(store, attemptId)) !== delegationDigest(evidence.owner)) {
    throw new Error('Attempt placement owner changed')
  }
  store.native.db
    .prepare(
      'INSERT OR IGNORE INTO project_task_attempt_placements(attempt_id,evidence_json) VALUES (?,?)'
    )
    .run(attemptId, JSON.stringify(evidence))
  if (delegationDigest(readTaskSessionPlacement(store, attemptId)) !== delegationDigest(evidence)) {
    throw new Error('Attempt placement is immutable')
  }
}

export function readTaskSessionPlacement(
  store: TaskWorkflowStore,
  attemptId: string
): AttemptPlacement {
  if (taskAttemptDispatchId(store, attemptId) !== null) {
    throw new Error('Expected session placement provenance')
  }
  const row = store.native.db
    .prepare('SELECT evidence_json FROM project_task_attempt_placements WHERE attempt_id=?')
    .get(attemptId)
  if (typeof row?.evidence_json !== 'string') {
    throw new Error(
      'Attempt execution placement provenance is unavailable; use genuine manual review'
    )
  }
  const placement = TaskAttemptPlacement.parse(JSON.parse(row.evidence_json))
  if (delegationDigest(taskAttemptAuthor(store, attemptId)) !== delegationDigest(placement.owner)) {
    throw new Error('Attempt placement owner changed')
  }
  return placement
}

export function requireTaskSourcePlacement(
  store: TaskWorkflowStore,
  attemptId: string,
  source: { worktreePath: string; workspaceId?: string; placementDigest?: string }
): void {
  const dispatchId = taskAttemptDispatchId(store, attemptId)
  let placement: AttemptPlacement
  if (!dispatchId) {
    placement = readTaskSessionPlacement(store, attemptId)
  } else {
    const dispatch = store.native.getDispatchContextById(dispatchId)
    const worker = store.native.getWorkerDispatch(dispatchId)
    if (
      !dispatch ||
      dispatch.status !== 'completed' ||
      store.native.getFederatedDispatch(dispatchId) ||
      !worker?.worktree_id ||
      worker.state !== 'succeeded' ||
      !dispatch.host_scope ||
      JSON.parse(dispatch.host_scope).kind !== 'local'
    ) {
      throw new Error('Settled owning-host Dispatch placement provenance is unavailable')
    }
    placement = {
      workspaceId: worker.worktree_id,
      executionHostId: 'local',
      worktreePath: source.worktreePath,
      owner: taskAttemptAuthor(store, attemptId)
    }
  }
  if (
    source.workspaceId !== placement.workspaceId ||
    source.worktreePath !== placement.worktreePath ||
    source.placementDigest !== delegationDigest({ attemptId, ...placement })
  ) {
    throw new Error('Source placement or attempt owner provenance changed')
  }
}
