import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import type {
  ProjectTaskAttempt,
  ProjectTaskEvent,
  ProjectTaskWorkflow
} from '../../shared/project-task-workflow'
import type { TaskWorkflowStore } from './task-workflow-store'

type AttemptRow = ProjectTaskAttempt & {
  sessionAttemptId: string | null
  checkpointPath: string | null
  reportPath: string | null
  blocker: string | null
  ownerAddress: string | null
  released: number
}

export function projectTaskWorkflow(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  summary = false
): ProjectTaskWorkflow {
  const state = store.item(projectId, task.id)
  const attempts = store.native.db
    .prepare(`SELECT a.id,a.native_task_id AS nativeTaskId,a.run_id AS runId,a.revision,a.created_at AS createdAt,
    d.id AS dispatchId,COALESCE(t.status,'unknown') AS nativeStatus,w.state AS workerState,d.assignee_handle AS terminal,
    s.attempt_id AS sessionAttemptId,s.checkpoint_path AS checkpointPath,s.report_path AS reportPath,s.blocker,s.owner_address AS ownerAddress,
    EXISTS(SELECT 1 FROM project_task_events e WHERE e.event_key='release:' || a.id) AS released
    FROM project_task_attempts a LEFT JOIN tasks t ON t.id=a.native_task_id
    LEFT JOIN dispatch_contexts d ON d.rowid=(SELECT candidate.rowid FROM dispatch_contexts candidate WHERE candidate.task_id=a.native_task_id ORDER BY candidate.rowid DESC LIMIT 1)
    LEFT JOIN worker_dispatches w ON w.dispatch_id=d.id
    LEFT JOIN project_task_session_attempts s ON s.attempt_id=a.id
    WHERE a.project_id=? AND a.task_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT ?`)
    .all(projectId, task.id, summary ? 1 : 50)
  const events = summary
    ? []
    : store.native.db
        .prepare(`SELECT sequence,task_id AS taskId,revision,kind,detail,created_at AS createdAt FROM project_task_events
    WHERE project_id=? AND task_id=? ORDER BY sequence DESC LIMIT 200`)
        .all(projectId, task.id)
  return {
    taskId: task.id,
    phase: state.phase,
    archived: state.archived === 1,
    approvedRevision: state.approved_revision,
    revisionChanged: state.approved_revision !== null && state.approved_revision !== task.revision,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SQL aliases map the owned attempt schema to the wire contract; missing native rows remain observable.
    attempts: (attempts as AttemptRow[]).map(
      ({
        sessionAttemptId,
        checkpointPath,
        reportPath,
        blocker,
        ownerAddress,
        released,
        ...attempt
      }) => ({
        ...attempt,
        session: sessionAttemptId
          ? { checkpointPath, reportPath, blocker, address: ownerAddress, released: released === 1 }
          : null
      })
    ),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SQL selects every ProjectTaskEvent field from the owned event schema.
    events: events as ProjectTaskEvent[],
    exportError: state.export_error,
    recordedSequence: Number(
      store.native.db
        .prepare(
          'SELECT COALESCE(MAX(sequence),0) AS latest FROM project_task_events WHERE project_id=? AND task_id=?'
        )
        .get(projectId, task.id)?.latest ?? 0
    )
  }
}
