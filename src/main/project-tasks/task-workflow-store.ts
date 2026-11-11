import { TaskDelegationPolicy, type DelegationContext } from './task-delegation-policy'
import { captureTaskAdmission, taskAdmission, taskResultAccepted } from './task-authorization'
import { randomUUID } from 'node:crypto'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import type { ProjectTaskPhase } from '../../shared/project-task-workflow'
import { scheduleProjectTaskActivity } from './task-activity'
import { projectTaskAttemptSpec } from './task-attempt-spec'

type Item = {
  current_revision: string
  approved_revision: string | null
  phase: ProjectTaskPhase
  archived: number
  export_error: string | null
}

export class TaskWorkflowStore {
  readonly delegation = new TaskDelegationPolicy(this)

  constructor(readonly native: OrchestrationDb) {}

  private registerHome(projectId: string, root: string): void {
    const home = this.native.db
      .prepare('SELECT root_path FROM project_task_homes WHERE project_id = ?')
      .get(projectId)
    if (home && home.root_path !== root) {
      throw new Error('Project ID already belongs to another root; explicit relocation is required')
    }
    this.native.db
      .prepare(
        'INSERT INTO project_task_homes(project_id,root_path) VALUES (?,?) ON CONFLICT(project_id) DO NOTHING'
      )
      .run(projectId, root)
  }

  register(projectId: string, root: string, task: ProjectTaskEntry): void {
    this.registerHome(projectId, root)
    const change = this.native.db
      .prepare(`INSERT INTO project_task_items(project_id,task_id,document_path,current_revision)
      VALUES (?,?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET
      exported_sequence=CASE WHEN document_path<>excluded.document_path THEN 0 ELSE exported_sequence END,
      export_error=CASE WHEN document_path<>excluded.document_path THEN NULL ELSE export_error END,
      document_path=excluded.document_path,current_revision=excluded.current_revision
      WHERE document_path<>excluded.document_path OR current_revision<>excluded.current_revision`)
      .run(projectId, task.id, task.path, task.revision)
    this.native.db
      .prepare(`INSERT INTO project_task_graph(project_id,task_id,parent_id,dependencies_json)
      VALUES (?,?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET
      parent_id=excluded.parent_id,dependencies_json=excluded.dependencies_json`)
      .run(projectId, task.id, task.parent, JSON.stringify(task.depends_on))
    if (change.changes) {
      scheduleProjectTaskActivity(this.native.db)
    }
  }

  syncGraph(projectId: string, root: string, tasks: ProjectTaskEntry[]): void {
    if (tasks.length > 1000) {
      throw new Error('Project task graph capacity exceeded')
    }
    const apply = () => {
      this.registerHome(projectId, root)
      this.native.db.prepare('DELETE FROM project_task_graph WHERE project_id=?').run(projectId)
      for (const task of tasks) {
        this.register(projectId, root, task)
      }
    }
    if (this.native.db.isTransaction) {
      apply()
    } else {
      this.transaction(apply)
    }
  }

  item(projectId: string, id: string): Item {
    const row = this.native.db
      .prepare(
        'SELECT current_revision,approved_revision,phase,archived,export_error FROM project_task_items WHERE project_id=? AND task_id=?'
      )
      .get(projectId, id)
    if (!row) {
      throw new Error('Project task is not registered')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: columns are created and written by this versioned store only.
    return row as Item
  }

  event(
    projectId: string,
    task: ProjectTaskEntry,
    kind: string,
    detail: string,
    key: string = randomUUID()
  ): void {
    this.native.db
      .prepare(
        'INSERT OR IGNORE INTO project_task_events(event_key,project_id,task_id,revision,kind,detail) VALUES (?,?,?,?,?,?)'
      )
      .run(key, projectId, task.id, task.revision, kind, detail.slice(0, 2000))
    scheduleProjectTaskActivity(this.native.db)
  }

  active(projectId: string, id: string): boolean {
    return !!this.native.db
      .prepare(`SELECT a.id FROM project_task_attempts a LEFT JOIN tasks t ON t.id=a.native_task_id
      LEFT JOIN dispatch_contexts d ON d.task_id=a.native_task_id
      LEFT JOIN worker_dispatches w ON w.dispatch_id=d.id
      WHERE a.project_id=? AND a.task_id=? AND (
        t.id IS NULL OR w.state IN ('starting','ready','start_unknown','stopping','stop_unknown')
        OR (w.dispatch_id IS NULL AND d.status IN ('pending','dispatched'))
        OR (d.id IS NULL AND t.status NOT IN ('completed','failed'))
      ) LIMIT 1`)
      .get(projectId, id)
  }

  approve(projectId: string, task: ProjectTaskEntry): void {
    const state = this.item(projectId, task.id)
    if (state.archived) {
      throw new Error('Restore the archived task before approval')
    }
    if (this.active(projectId, task.id)) {
      throw new Error('Settle the active attempt before approving a plan')
    }
    if (state.approved_revision === task.revision) {
      if (state.phase === 'ready') {
        return
      }
      if (['review', 'integration', 'done'].includes(state.phase)) {
        throw new Error(
          'Record a review decision or edit the plan before approving another attempt'
        )
      }
    }
    this.native.db
      .prepare(
        "UPDATE project_task_items SET approved_revision=?,phase='ready' WHERE project_id=? AND task_id=? AND archived=0"
      )
      .run(task.revision, projectId, task.id)
    this.event(
      projectId,
      task,
      'plan.approved',
      'Plan revision approved by the interactive operator',
      randomUUID()
    )
  }

  requireReady(
    projectId: string,
    task: ProjectTaskEntry,
    dependencies: ProjectTaskEntry[],
    context?: DelegationContext
  ): void {
    const state = this.item(projectId, task.id)
    if (!taskAdmission(this, projectId, task, context) || state.phase === 'done') {
      throw new Error('Approve the current plan revision before starting')
    }
    if (this.active(projectId, task.id)) {
      throw new Error('An active or unverified attempt already owns this task')
    }
    if (state.phase !== 'ready') {
      throw new Error('An operator must return this task to ready before another attempt')
    }
    for (const dependency of dependencies) {
      if (!taskResultAccepted(this, projectId, dependency)) {
        throw new Error('A business dependency has not been accepted at its current revision')
      }
    }
  }

  prepare(
    projectId: string,
    task: ProjectTaskEntry,
    runId: string,
    dependencies: ProjectTaskEntry[],
    context?: DelegationContext
  ) {
    this.requireReady(projectId, task, dependencies, context)
    const nativeTask = this.native.createTask({
      runId,
      spec: projectTaskAttemptSpec(
        String(
          this.native.db
            .prepare('SELECT root_path FROM project_task_homes WHERE project_id=?')
            .get(projectId)?.root_path
        ),
        task
      ),
      taskTitle: task.title
    })
    const id = randomUUID()
    this.native.db
      .prepare(
        'INSERT INTO project_task_attempts(id,project_id,task_id,revision,native_task_id,run_id) VALUES (?,?,?,?,?,?)'
      )
      .run(id, projectId, task.id, task.revision, nativeTask.id, runId)
    captureTaskAdmission(this, projectId, task, id, context)
    this.native.db
      .prepare("UPDATE project_task_items SET phase='active' WHERE project_id=? AND task_id=?")
      .run(projectId, task.id)
    this.event(
      projectId,
      task,
      'attempt.reserved',
      `Run ${runId}; runtime task ${nativeTask.id}`,
      `reserve:${id}`
    )
    return { id, nativeTask }
  }

  decide(
    projectId: string,
    task: ProjectTaskEntry,
    action: 'changes' | 'integration' | 'accept',
    reason: string
  ): void {
    const item = this.item(projectId, task.id)
    if (
      item.archived ||
      item.approved_revision !== task.revision ||
      this.active(projectId, task.id)
    ) {
      throw new Error('Current plan approval and a settled attempt are required')
    }
    if (!['review', 'integration'].includes(item.phase)) {
      throw new Error('Task is not awaiting a review decision')
    }
    if (!reason.trim()) {
      throw new Error('Record the review result and evidence before accepting')
    }
    const phase = action === 'changes' ? 'ready' : action === 'integration' ? 'integration' : 'done'
    this.native.db
      .prepare('UPDATE project_task_items SET phase=? WHERE project_id=? AND task_id=?')
      .run(phase, projectId, task.id)
    this.event(projectId, task, `review.${action}`, reason)
  }

  archive(projectId: string, task: ProjectTaskEntry, archived: boolean): void {
    if (this.active(projectId, task.id)) {
      throw new Error('Cannot archive an active or unverified attempt')
    }
    this.native.db
      .prepare('UPDATE project_task_items SET archived=? WHERE project_id=? AND task_id=?')
      .run(archived ? 1 : 0, projectId, task.id)
    this.event(
      projectId,
      task,
      archived ? 'task.archived' : 'task.restored',
      'Operator changed archive visibility'
    )
  }

  moveManual(
    projectId: string,
    task: ProjectTaskEntry,
    phase: 'draft' | 'active' | 'review' | 'done',
    reason: string
  ): void {
    if (
      this.item(projectId, task.id).archived ||
      this.native.db
        .prepare('SELECT id FROM project_task_attempts WHERE project_id=? AND task_id=? LIMIT 1')
        .get(projectId, task.id)
    ) {
      throw new Error(
        'Managed attempts use their runtime lifecycle and review decisions, not manual moves'
      )
    }
    if (phase === 'done' && !reason.trim()) {
      throw new Error('Record the result and checks before completing this task')
    }
    this.native.db
      .prepare(
        'UPDATE project_task_items SET phase=?,approved_revision=? WHERE project_id=? AND task_id=?'
      )
      .run(phase, phase === 'done' ? task.revision : null, projectId, task.id)
    this.event(
      projectId,
      task,
      `manual.${phase}`,
      reason.trim() || 'Operator moved the task; no worker was started or declared finished'
    )
  }

  transaction<T>(operation: () => T, beforeCommit: () => void = () => {}): T {
    this.native.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      beforeCommit()
      this.native.db.exec('COMMIT')
      return result
    } catch (error) {
      this.native.db.exec('ROLLBACK')
      throw error
    }
  }
}
