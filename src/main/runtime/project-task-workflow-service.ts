import { stringify } from 'yaml'
import type { RpcContext } from './rpc/core'
import type { OrcaRuntimeService } from './orca-runtime'
import { resolveProjectTaskWorkspace } from './project-task-workspaces'
import { TaskWorkflowStore } from '../project-tasks/task-workflow-store'
import { projectTaskWorkflow } from '../project-tasks/task-workflow-view'
import { exportProjectTaskActivity } from '../project-tasks/task-activity'
import type { OrchestrationDb } from './orchestration/db'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'

const stores = new WeakMap<OrchestrationDb, TaskWorkflowStore>()
export function requireInteractiveTaskOperator(context: Pick<RpcContext, 'caller'>): void {
  if (!context.caller || context.caller.kind === 'local-cli') {
    throw new Error(
      'This action requires confirmation in the Orca desktop or paired-device interface'
    )
  }
}

export async function projectTaskResources(
  runtime: OrcaRuntimeService,
  selector: string,
  expectedHost?: string
) {
  const target = await resolveProjectTaskWorkspace(runtime, selector, expectedHost)
  const snapshot = await target.workspace.snapshot()
  const native = runtime.getOrchestrationDb()
  let store = stores.get(native)
  if (!store) {
    store = new TaskWorkflowStore(native)
    stores.set(native, store)
  }
  for (const task of snapshot.tasks) {
    store.register(snapshot.project.id, target.root, task)
  }
  return { ...target, snapshot, store, projectId: snapshot.project.id }
}

export async function taskWorkflowAction(
  runtime: OrcaRuntimeService,
  params: { worktree: string; id: string; revision: string; expectedExecutionHostId: string },
  operation: (
    resources: Awaited<ReturnType<typeof projectTaskResources>>,
    task: ProjectTaskEntry
  ) => void
) {
  const resources = await projectTaskResources(
    runtime,
    params.worktree,
    params.expectedExecutionHostId
  )
  await resources.workspace.withTaskRevision(params.id, params.revision, async (task, snapshot) => {
    resources.store.transaction(() => {
      for (const entry of snapshot.tasks) {
        resources.store.register(resources.projectId, resources.root, entry)
      }
      operation({ ...resources, snapshot }, task)
    })
  })
  await exportProjectTaskActivity(resources.store.native.db)
  resources.workspace.notifyChanged()
  return projectTaskWorkflow(
    resources.store,
    resources.projectId,
    await resources.workspace.show(params.id)
  )
}

export function renamedTaskContent(
  task: {
    content: string
    body: string
    schema: 1
    id: string
    kind: string
    parent: string | null
    depends_on: string[]
    repos: string[]
  },
  title: string
): string {
  return `---\n${stringify({ schema: task.schema, id: task.id, title, kind: task.kind, parent: task.parent, depends_on: task.depends_on, repos: task.repos }).trimEnd()}\n---\n${task.body}`
}
