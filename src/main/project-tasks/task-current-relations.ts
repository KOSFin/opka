import { z } from 'zod'
import type { TaskWorkflowStore } from './task-workflow-store'

export function currentTaskRelations(
  store: TaskWorkflowStore,
  projectId: string,
  taskId: string
): string[] {
  const row = store.native.db
    .prepare('SELECT dependencies_json FROM project_task_graph WHERE project_id=? AND task_id=?')
    .get(projectId, taskId)
  if (typeof row?.dependencies_json !== 'string') {
    throw new Error('Current task graph is unavailable')
  }
  const dependencies = z.array(z.string()).max(1000).parse(JSON.parse(row.dependencies_json))
  const children = store.native.db
    .prepare('SELECT task_id FROM project_task_graph WHERE project_id=? AND parent_id=? LIMIT 1001')
    .all(projectId, taskId)
    .map((child) => z.string().parse(child.task_id))
  const ids = [...new Set([...dependencies, ...children])].sort()
  if (ids.length > 1000) {
    throw new Error('Project task graph capacity exceeded')
  }
  return ids
}
