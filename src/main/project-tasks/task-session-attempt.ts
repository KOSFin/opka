import { z } from 'zod'
import type { TaskWorkflowStore } from './task-workflow-store'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'

const SessionAttempt = z.object({
  id: z.string(),
  nativeTaskId: z.string(),
  revision: z.string(),
  ownerKey: z.string(),
  ownerAddress: z.string().nullable(),
  checkpointPath: z.string().nullable(),
  reportPath: z.string().nullable(),
  blocker: z.string().nullable(),
  resultHash: z.string().nullable(),
  nativeStatus: z.string()
})
export type TaskSessionAttempt = z.infer<typeof SessionAttempt>

export function readTaskSessionAttempt(
  store: TaskWorkflowStore,
  projectId: string,
  taskId: string,
  attemptId?: string
): TaskSessionAttempt | null {
  const row = store.native.db
    .prepare(`SELECT a.id,a.native_task_id AS nativeTaskId,a.revision,s.owner_key AS ownerKey,
    s.checkpoint_path AS checkpointPath,s.report_path AS reportPath,s.blocker,s.result_hash AS resultHash,
    COALESCE(t.status,'unknown') AS nativeStatus,s.owner_address AS ownerAddress
    FROM project_task_attempts a JOIN project_task_session_attempts s ON s.attempt_id=a.id
    LEFT JOIN tasks t ON t.id=a.native_task_id
    WHERE a.project_id=? AND a.task_id=? AND (? IS NULL OR a.id=?)
    ORDER BY a.rowid DESC LIMIT 1`)
    .get(projectId, taskId, attemptId ?? null, attemptId ?? null)
  return row ? SessionAttempt.parse(row) : null
}

export function requireTaskSessionOwner(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  attemptId: string,
  ownerKey: string,
  allowChangedPlan = false
): TaskSessionAttempt {
  const attempt = readTaskSessionAttempt(store, projectId, task.id, attemptId)
  if (!attempt || attempt.ownerKey !== ownerKey) {
    throw new Error('This attempt belongs to another chat; no task documents were changed')
  }
  const state = store.item(projectId, task.id)
  if (
    state.archived ||
    (!allowChangedPlan &&
      (state.current_revision !== task.revision ||
        attempt.revision !== task.revision ||
        state.approved_revision !== task.revision))
  ) {
    throw new Error('The approved plan changed; re-read the task and request operator approval')
  }
  return attempt
}

export function isTaskSessionReleased(store: TaskWorkflowStore, attemptId: string): boolean {
  return !!store.native.db
    .prepare('SELECT 1 FROM project_task_events WHERE event_key=?')
    .get(`release:${attemptId}`)
}

export function claimTaskSession(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  runId: string,
  ownerKey: string,
  dependencies: ProjectTaskEntry[],
  ownerAddress: string | null = null
): TaskSessionAttempt {
  return store.transaction(() => {
    if (store.active(projectId, task.id)) {
      const prior = readTaskSessionAttempt(store, projectId, task.id)
      if (!prior || ['completed', 'failed', 'unknown'].includes(prior.nativeStatus)) {
        throw new Error('An active or unverified attempt already owns this task')
      }
      return requireTaskSessionOwner(store, projectId, task, prior.id, ownerKey)
    }
    const attempt = store.prepare(projectId, task, runId, dependencies)
    store.native.db
      .prepare(
        'INSERT INTO project_task_session_attempts(attempt_id,owner_key,owner_address) VALUES (?,?,?)'
      )
      .run(attempt.id, ownerKey, ownerAddress)
    store.event(
      projectId,
      task,
      'attempt.claimed',
      'Existing chat took this task; no worker was spawned'
    )
    const binding = readTaskSessionAttempt(store, projectId, task.id, attempt.id)
    if (!binding) {
      throw new Error('Session attempt was not recorded')
    }
    return binding
  })
}

export function recordTaskSessionProgress(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  attemptId: string,
  ownerKey: string,
  input: {
    checkpointPath: string | null
    blocker: string | null
    reportPath?: string
    resultHash?: string
    release?: boolean
  }
): TaskSessionAttempt {
  return store.transaction(() => {
    if ((input.resultHash === undefined) !== (input.reportPath === undefined)) {
      throw new Error('A completed result requires its report and content hash')
    }
    if (input.release && (input.reportPath || input.resultHash)) {
      throw new Error('Release saves progress, not a completed result')
    }
    const prior = requireTaskSessionOwner(
      store,
      projectId,
      task,
      attemptId,
      ownerKey,
      input.release
    )
    if (input.release && isTaskSessionReleased(store, attemptId)) {
      return prior
    }
    if (prior.resultHash !== null) {
      if (input.resultHash === prior.resultHash) {
        return prior
      }
      throw new Error(
        'The attempt has already submitted its result; start a reviewed follow-up instead'
      )
    }
    if (['completed', 'failed', 'unknown'].includes(prior.nativeStatus)) {
      throw new Error('The previous attempt is settled or unverifiable; no result was accepted')
    }
    store.native.db
      .prepare(`UPDATE project_task_session_attempts SET checkpoint_path=?,blocker=?,
        report_path=COALESCE(?,report_path),result_hash=COALESCE(?,result_hash) WHERE attempt_id=?`)
      .run(
        input.checkpointPath,
        input.blocker,
        input.reportPath ?? null,
        input.resultHash ?? null,
        attemptId
      )
    if (input.resultHash) {
      store.native.updateTaskStatus(prior.nativeTaskId, 'completed', input.reportPath)
    }
    if (input.release) {
      store.native.updateTaskStatus(
        prior.nativeTaskId,
        'failed',
        'Owner released this task attempt; chat and process were not stopped'
      )
      store.native.db
        .prepare(
          "UPDATE project_task_items SET phase=CASE WHEN approved_revision=? AND current_revision=? THEN 'ready' ELSE 'draft' END WHERE project_id=? AND task_id=?"
        )
        .run(task.revision, task.revision, projectId, task.id)
    }
    store.event(
      projectId,
      task,
      input.release
        ? 'attempt.released'
        : input.resultHash
          ? 'attempt.result'
          : input.blocker
            ? 'attempt.blocked'
            : 'attempt.checkpoint',
      input.blocker ?? input.reportPath ?? input.checkpointPath ?? 'No checkpoint saved',
      input.release ? `release:${attemptId}` : input.resultHash ? `result:${attemptId}` : undefined
    )
    return {
      ...prior,
      ...input,
      reportPath: input.reportPath ?? prior.reportPath,
      resultHash: input.resultHash ?? prior.resultHash,
      nativeStatus: input.release ? 'failed' : input.resultHash ? 'completed' : prior.nativeStatus
    }
  })
}
