import { defineMethod } from '../core'
import {
  ProjectTaskClaim,
  ProjectTaskProgress,
  ProjectTaskComplete,
  ProjectTaskDocuments,
  ProjectTaskAgentIntegration
} from '../../../../shared/rpc-contract/project-task-workflow-params'
import { claimProjectTaskSession, progressProjectTaskSession } from '../../project-task-session'
import {
  projectTaskResources,
  requireInteractiveTaskOperator
} from '../../project-task-workflow-service'
import { taskDocuments } from '../../../project-tasks/task-documents'

export const PROJECT_TASK_SESSION_METHODS = [
  defineMethod({
    name: 'projectTask.enableAgentTasks',
    permission: 'workspace',
    params: ProjectTaskAgentIntegration,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      return resources.workspace.enableAgentTasks()
    }
  }),
  defineMethod({
    name: 'projectTask.documents',
    permission: 'workspace',
    params: ProjectTaskDocuments,
    handler: async (params, { runtime }) => {
      const resources = await projectTaskResources(runtime, params.worktree)
      const task = await resources.workspace.show(params.id)
      return taskDocuments(resources.root, task.path, params.path)
    }
  }),
  defineMethod({
    name: 'projectTask.claim',
    permission: 'workspace',
    params: ProjectTaskClaim,
    handler: claimProjectTaskSession
  }),
  defineMethod({
    name: 'projectTask.progress',
    permission: 'workspace',
    params: ProjectTaskProgress,
    handler: progressProjectTaskSession
  }),
  defineMethod({
    name: 'projectTask.complete',
    permission: 'workspace',
    params: ProjectTaskComplete,
    handler: progressProjectTaskSession
  })
]
