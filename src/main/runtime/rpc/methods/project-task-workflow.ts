import { defineMethod, defineStreamingMethod } from '../core'
import {
  ProjectTaskIdentity,
  ProjectTaskList,
  ProjectTaskTarget
} from '../../../../shared/rpc-contract/project-task-params'
import {
  ProjectTaskAction,
  ProjectTaskArchive,
  ProjectTaskMove,
  ProjectTaskDecision,
  ProjectTaskRename,
  ProjectTaskStart,
  ProjectTaskStop
} from '../../../../shared/rpc-contract/project-task-workflow-params'
import {
  projectTaskResources,
  taskWorkflowAction,
  requireInteractiveTaskOperator,
  renamedTaskContent
} from '../../project-task-workflow-service'
import { projectTaskWorkflow } from '../../../project-tasks/task-workflow-view'
import { exportProjectTaskActivity } from '../../../project-tasks/task-activity'
import { startProjectTask } from '../../project-task-launch'
import { resumeProjectTask } from '../../project-task-resume'
import { ORCHESTRATION_WORKER_STOP_METHODS } from './orchestration/worker/worker-stop'
import { PROJECT_TASK_SESSION_METHODS } from './project-task-session'

export const PROJECT_TASK_WORKFLOW_METHODS = [
  ...PROJECT_TASK_SESSION_METHODS,
  defineMethod({
    name: 'projectTask.move',
    permission: 'workspace',
    params: ProjectTaskMove,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      return taskWorkflowAction(context.runtime, params, ({ store, projectId, snapshot }, task) => {
        if (
          params.phase === 'done' &&
          snapshot.tasks.some(
            (entry) =>
              (entry.parent === task.id || task.depends_on.includes(entry.id)) &&
              (store.item(projectId, entry.id).phase !== 'done' ||
                store.item(projectId, entry.id).approved_revision !== entry.revision)
          )
        ) {
          throw new Error(
            'Complete current dependencies and subtasks before completing their parent'
          )
        }
        store.moveManual(projectId, task, params.phase, params.reason)
      })
    }
  }),
  defineMethod({
    name: 'projectTask.stop',
    permission: 'workspace',
    params: ProjectTaskStop,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      const binding = resources.store.native.db
        .prepare(
          `SELECT a.id FROM project_task_attempts a JOIN dispatch_contexts d ON d.task_id=a.native_task_id WHERE a.project_id=? AND a.task_id=? AND d.id=?`
        )
        .get(resources.projectId, params.id, params.dispatch)
      if (!binding) {
        throw new Error('Dispatch does not belong to this project task')
      }
      if (resources.store.native.getFederatedDispatch(params.dispatch)) {
        throw new Error('Use the existing durable federation stop path on the owning host')
      }
      const result = await ORCHESTRATION_WORKER_STOP_METHODS[0].handler(
        { dispatch: params.dispatch },
        context
      )
      await exportProjectTaskActivity(resources.store.native.db)
      resources.workspace.notifyChanged()
      return result
    }
  }),
  defineMethod({
    name: 'projectTask.resume',
    permission: 'workspace',
    params: ProjectTaskIdentity,
    handler: async (params, { runtime }) => resumeProjectTask(runtime, params.worktree, params.id)
  }),
  defineMethod({
    name: 'projectTask.start',
    permission: 'workspace',
    params: ProjectTaskStart,
    handler: startProjectTask
  }),
  defineMethod({
    name: 'projectTask.board',
    permission: 'workspace',
    params: ProjectTaskList,
    handler: async (params, { runtime }) => {
      const resources = await projectTaskResources(runtime, params.worktree)
      return {
        project: resources.snapshot.project,
        executionHostId: resources.executionHostId,
        total: resources.snapshot.tasks.length,
        diagnostics: resources.snapshot.diagnostics,
        tasks: resources.snapshot.tasks
          .slice(params.offset, params.offset + params.limit)
          .map(({ content: _content, body: _body, ...task }) => ({
            ...task,
            workflow: projectTaskWorkflow(
              resources.store,
              resources.projectId,
              {
                ...task,
                content: '',
                body: ''
              },
              true
            )
          }))
      }
    }
  }),
  defineMethod({
    name: 'projectTask.workflow',
    permission: 'workspace',
    params: ProjectTaskIdentity,
    handler: async (params, { runtime }) => {
      const resources = await projectTaskResources(runtime, params.worktree)
      return projectTaskWorkflow(
        resources.store,
        resources.projectId,
        await resources.workspace.show(params.id)
      )
    }
  }),
  defineMethod({
    name: 'projectTask.approve',
    permission: 'workspace',
    params: ProjectTaskAction,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      return taskWorkflowAction(context.runtime, params, ({ store, projectId }, task) =>
        store.approve(projectId, task)
      )
    }
  }),
  defineMethod({
    name: 'projectTask.decide',
    permission: 'workspace',
    params: ProjectTaskDecision,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      return taskWorkflowAction(context.runtime, params, ({ store, projectId, snapshot }, task) => {
        if (
          params.action === 'accept' &&
          snapshot.tasks.some(
            (child) =>
              child.parent === task.id &&
              (store.item(projectId, child.id).phase !== 'done' ||
                store.item(projectId, child.id).approved_revision !== child.revision)
          )
        ) {
          throw new Error('Accept the current child-task results before accepting their parent')
        }
        store.decide(projectId, task, params.action, params.reason)
      })
    }
  }),
  defineMethod({
    name: 'projectTask.archive',
    permission: 'workspace',
    params: ProjectTaskArchive,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      return taskWorkflowAction(context.runtime, params, ({ store, projectId }, task) =>
        store.archive(projectId, task, params.archived)
      )
    }
  }),
  defineMethod({
    name: 'projectTask.rename',
    permission: 'workspace',
    params: ProjectTaskRename,
    handler: async (params, { runtime }) => {
      const resources = await projectTaskResources(
        runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      const task = await resources.workspace.show(params.id)
      return resources.workspace.update(
        params.id,
        params.revision,
        renamedTaskContent(task, params.title)
      )
    }
  }),
  defineMethod({
    name: 'projectTask.delete',
    permission: 'workspace',
    params: ProjectTaskAction,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      await resources.workspace.deleteDocument(params.id, params.revision, (task) => {
        if (resources.store.active(resources.projectId, params.id)) {
          throw new Error('Settle the active attempt before deleting its document')
        }
        resources.store.transaction(() => {
          resources.store.archive(resources.projectId, task, true)
          resources.store.native.db
            .prepare(
              'UPDATE project_task_items SET approved_revision=NULL WHERE project_id=? AND task_id=?'
            )
            .run(resources.projectId, task.id)
          resources.store.event(
            resources.projectId,
            task,
            'task.delete_requested',
            'Operator revoked approval before removing the document; history and notes retained'
          )
        })
      })
      return {
        deleted: true,
        retained: 'Notes, reports, chats, worktrees and runtime history were not removed'
      }
    }
  }),
  defineMethod({
    name: 'projectTask.retryExport',
    permission: 'workspace',
    params: ProjectTaskTarget,
    handler: async (params, { runtime }) => {
      const { store, projectId } = await projectTaskResources(runtime, params.worktree)
      store.native.db
        .prepare('UPDATE project_task_items SET export_error=NULL WHERE project_id=?')
        .run(projectId)
      await exportProjectTaskActivity(store.native.db)
      return { requested: true }
    }
  }),
  defineStreamingMethod({
    name: 'projectTask.watch',
    permission: 'workspace',
    params: ProjectTaskTarget,
    handler: async (params, { runtime, signal }, emit) => {
      const { workspace } = await projectTaskResources(runtime, params.worktree)
      if (signal?.aborted) {
        return
      }
      await new Promise<void>((resolve) => {
        const unsubscribe = workspace.subscribe(() => emit({ type: 'changed' }))
        const done = () => {
          unsubscribe()
          signal?.removeEventListener('abort', done)
          resolve()
        }
        signal?.addEventListener('abort', done, { once: true })
        emit({ type: 'ready' })
        emit({ type: 'changed' })
        if (signal?.aborted) {
          done()
        }
      })
    }
  })
]
