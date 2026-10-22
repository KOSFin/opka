import type Database from '../sqlite/sync-database'
import { dirname } from 'node:path'
import { PROJECT_TASK_WORKFLOW_SQL } from './task-workflow-schema'
import { taskFilePath } from './task-file-io'
import { writePluginFileAtomically } from '../plugins/plugin-atomic-file-write'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'

const schedules = new WeakMap<Database.Database, { pending: boolean; closed: boolean }>()
const exports = new WeakMap<Database.Database, Map<string, Promise<void>>>()

export function installProjectTaskActivity(db: Database.Database): void {
  db.exec(PROJECT_TASK_WORKFLOW_SQL)
  schedules.set(db, { pending: false, closed: false })
  scheduleProjectTaskActivity(db)
}

export function closeProjectTaskActivity(db: Database.Database): void {
  const state = schedules.get(db)
  if (state) {
    state.closed = true
  }
}

export function scheduleProjectTaskActivity(db: Database.Database): void {
  const state = schedules.get(db)
  if (!state || state.closed || state.pending) {
    return
  }
  state.pending = true
  const timer = setTimeout(() => {
    state.pending = false
    if (state.closed) {
      return
    }
    if (db.isTransaction) {
      scheduleProjectTaskActivity(db)
      return
    }
    void exportProjectTaskActivity(db).catch(() => undefined)
  }, 50)
  timer.unref()
}

export async function exportProjectTaskActivity(db: Database.Database): Promise<void> {
  let queue = exports.get(db)
  if (!queue) {
    queue = new Map()
    exports.set(db, queue)
  }
  return runKeyedSerializedOperation(queue, 'activity', () => exportCommittedActivity(db))
}

async function exportCommittedActivity(db: Database.Database): Promise<void> {
  if (schedules.get(db)?.closed) {
    return
  }
  if (db.isTransaction) {
    throw new Error('Activity export requires committed runtime state')
  }
  const pending = db
    .prepare(`SELECT i.project_id,i.task_id,i.document_path,h.root_path,
    (SELECT MAX(e.sequence) FROM project_task_events e WHERE e.project_id=i.project_id AND e.task_id=i.task_id) AS latest
    FROM project_task_items i JOIN project_task_homes h ON h.project_id=i.project_id
    WHERE i.export_error IS NULL AND COALESCE((SELECT MAX(e.sequence) FROM project_task_events e
      WHERE e.project_id=i.project_id AND e.task_id=i.task_id),0)>i.exported_sequence LIMIT 20`)
    .all()
  for (const row of pending) {
    const projectId = String(row.project_id),
      taskId = String(row.task_id),
      latest = Number(row.latest)
    try {
      const events = db
        .prepare(`SELECT sequence,kind,detail,created_at FROM project_task_events
        WHERE project_id=? AND task_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 200`)
        .all(projectId, taskId, latest)
        .toReversed()
      const lines = events.map(
        (event) =>
          `- ${String(event.created_at)} · ${String(event.kind)} — ${JSON.stringify(event.detail)}`
      )
      const path = await taskFilePath(
        String(row.root_path),
        `${dirname(String(row.document_path)).replaceAll('\\', '/')}/activity.md`,
        true
      )
      await writePluginFileAtomically(
        path,
        `# Runtime activity\n\nGenerated from committed Orca state. Do not edit as authority. Latest ${events.length} events; through sequence ${latest}.\n\n${lines.join('\n')}\n`,
        { mode: 0o644 }
      )
      if (schedules.get(db)?.closed) {
        return
      }
      db.prepare(
        'UPDATE project_task_items SET exported_sequence=MAX(exported_sequence,?),export_error=NULL WHERE project_id=? AND task_id=?'
      ).run(latest, projectId, taskId)
    } catch {
      if (schedules.get(db)?.closed) {
        return
      }
      db.prepare(
        'UPDATE project_task_items SET export_error=? WHERE project_id=? AND task_id=?'
      ).run(
        'Activity export failed; inspect the document path and retry explicitly',
        projectId,
        taskId
      )
    }
  }
  if (pending.length === 20) {
    scheduleProjectTaskActivity(db)
  }
}
