import { defineMethod } from '../core'
import {
  ProjectTaskTarget,
  ProjectTaskList,
  ProjectTaskIdentity,
  ProjectTaskInit,
  ProjectTaskCreate,
  ProjectTaskUpdate
} from '../../../../shared/rpc-contract/project-task-params'
import { resolveProjectTaskWorkspace } from '../../project-task-workspaces'
import { readTaskProjectCatalog } from '../../../project-tasks/task-project-roots'

export const PROJECT_TASK_METHODS = [
  defineMethod({
    name: 'projectTask.catalog',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => readTaskProjectCatalog(runtime)
  }),
  defineMethod({
    name: 'projectTask.target',
    permission: 'workspace',
    params: ProjectTaskTarget,
    handler: async (params, { runtime }) => {
      const { workspace: _workspace, executionHostId } = await resolveProjectTaskWorkspace(
        runtime,
        params.worktree
      )
      return { executionHostId }
    }
  }),
  defineMethod({
    name: 'projectTask.init',
    permission: 'workspace',
    params: ProjectTaskInit,
    handler: async (params, { runtime }) => {
      const { workspace } = await resolveProjectTaskWorkspace(
        runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      return workspace.initialize(params.content)
    }
  }),
  defineMethod({
    name: 'projectTask.list',
    permission: 'workspace',
    params: ProjectTaskList,
    handler: async (params, { runtime }) => {
      const { workspace, executionHostId } = await resolveProjectTaskWorkspace(
        runtime,
        params.worktree
      )
      const snapshot = await workspace.snapshot()
      return {
        project: snapshot.project,
        executionHostId,
        diagnostics: snapshot.diagnostics,
        total: snapshot.tasks.length,
        offset: params.offset,
        tasks: snapshot.tasks
          .slice(params.offset, params.offset + params.limit)
          .map(({ content: _content, body: _body, ...task }) => task)
      }
    }
  }),
  defineMethod({
    name: 'projectTask.show',
    permission: 'workspace',
    params: ProjectTaskIdentity,
    handler: async (params, { runtime }) => {
      const { workspace } = await resolveProjectTaskWorkspace(runtime, params.worktree)
      return workspace.show(params.id)
    }
  }),
  defineMethod({
    name: 'projectTask.context',
    permission: 'workspace',
    params: ProjectTaskIdentity,
    handler: async (params, { runtime }) => {
      const { workspace } = await resolveProjectTaskWorkspace(runtime, params.worktree)
      return workspace.context(params.id)
    }
  }),
  defineMethod({
    name: 'projectTask.create',
    permission: 'workspace',
    params: ProjectTaskCreate,
    handler: async (params, { runtime }) => {
      const { workspace } = await resolveProjectTaskWorkspace(
        runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      return workspace.create(params.source, params.slug, params.content)
    }
  }),
  defineMethod({
    name: 'projectTask.update',
    permission: 'workspace',
    params: ProjectTaskUpdate,
    handler: async (params, { runtime }) => {
      const { workspace } = await resolveProjectTaskWorkspace(
        runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      return workspace.update(params.id, params.revision, params.content)
    }
  })
]
