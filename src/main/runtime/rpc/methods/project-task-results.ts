import { readDelegationMutation } from '../../../project-tasks/task-delegation-mutations'
import { projectTaskWorkflow } from '../../../project-tasks/task-workflow-view'
import { defineMethod } from '../core'
import {
  TaskResultSnapshot,
  TaskReviewAssignment,
  TaskReviewSubmission,
  TaskDelegatedDecision
} from '../../../../shared/rpc-contract/project-task-result-params'
import { assignTaskReview, recordTaskReview } from '../../../project-tasks/task-independent-review'
import { decideDelegatedResult } from '../../../project-tasks/task-result-decisions'
import { freezeTaskResult, readTaskResult } from '../../../project-tasks/task-result-evidence'
import { projectTaskResources, taskWorkflowAction } from '../../project-task-workflow-service'
import {
  projectTaskDelegationContext,
  requireTaskDelegationCapability
} from '../../project-task-delegation'
import {
  projectTaskCodeSnapshot,
  verifyProjectTaskResultSource
} from '../../project-task-code-snapshot'

export const PROJECT_TASK_RESULT_METHODS = [
  defineMethod({
    name: 'projectTask.resultSnapshot',
    permission: 'workspace',
    params: TaskResultSnapshot,
    handler: async (params, context) => {
      requireTaskDelegationCapability(context, params.capability)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      const task = await resources.workspace.show(params.id)
      const author = projectTaskDelegationContext(context, resources, params.from)
      const payload = {
        attempt: params.attempt,
        sourceWorktree: params.sourceWorktree,
        revision: params.revision,
        id: params.id
      }
      const replay = readDelegationMutation(
        resources.store,
        resources.projectId,
        'result.snapshot',
        params.requestId,
        author.actor.key,
        payload
      )
      if (replay) {
        return {
          receipt: replay,
          workflow: projectTaskWorkflow(resources.store, resources.projectId, task, false, author)
        }
      }
      const source = await projectTaskCodeSnapshot(
        context,
        resources,
        task,
        params.sourceWorktree,
        params.attempt
      )
      let receipt: unknown
      const workflow = await taskWorkflowAction(
        context.runtime,
        params,
        (current, entry) => {
          const actor = projectTaskDelegationContext(context, current, params.from)
          const prior = current.store.native.db
            .prepare(
              'SELECT digest FROM project_task_results WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1'
            )
            .get(params.attempt)
          if (typeof prior?.digest !== 'string') {
            throw new Error('The exact settled result is missing')
          }
          const result = readTaskResult(current.store, prior.digest)
          const attempt = current.store.native.db
            .prepare('SELECT project_id,task_id FROM project_task_attempts WHERE id=?')
            .get(params.attempt)
          if (
            attempt?.project_id !== current.projectId ||
            attempt.task_id !== entry.id ||
            result.author.key !== actor.actor.key ||
            result.planRevision !== entry.revision
          ) {
            throw new Error('Only the verified result author can record this exact source snapshot')
          }
          receipt = current.store.delegation.mutate(
            current.projectId,
            'result.snapshot',
            params.requestId,
            actor.actor.key,
            payload,
            () => {
              const frozen = freezeTaskResult(current.store, { ...result, kind: 'code', source })
              return {
                id: frozen.id,
                operation: 'result.snapshot',
                generation: null,
                resultDigest: frozen.digest
              }
            }
          )
        },
        (resources) => projectTaskDelegationContext(context, resources, params.from)
      )
      return { receipt, workflow }
    }
  }),
  defineMethod({
    name: 'projectTask.reviewAssign',
    permission: 'workspace',
    params: TaskReviewAssignment,
    handler: async (params, context) => {
      requireTaskDelegationCapability(context, params.capability)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      const task = await resources.workspace.show(params.id)
      const actor = projectTaskDelegationContext(context, resources, params.from)
      const replay = readDelegationMutation(
        resources.store,
        resources.projectId,
        'review.assign',
        params.requestId,
        actor.actor.key,
        params
      )
      if (replay) {
        return {
          receipt: replay,
          workflow: projectTaskWorkflow(resources.store, resources.projectId, task, false, actor)
        }
      }
      await verifyProjectTaskResultSource(
        context,
        resources,
        await resources.workspace.show(params.id),
        params.resultDigest
      )
      let receipt: unknown
      const workflow = await taskWorkflowAction(
        context.runtime,
        params,
        (resources, task) => {
          const actor = projectTaskDelegationContext(context, resources, params.from)
          receipt = resources.store.delegation.mutate(
            resources.projectId,
            'review.assign',
            params.requestId,
            actor.actor.key,
            params,
            () => {
              const assignment = assignTaskReview(
                resources.store,
                actor,
                task.id,
                params.resultDigest,
                params.reviewerAttempt
              )
              return {
                ...assignment,
                operation: 'review.assign',
                generation: resources.store.delegation.read(resources.projectId).generation
              }
            }
          )
        },
        (resources) => projectTaskDelegationContext(context, resources, params.from)
      )
      return { receipt, workflow }
    }
  }),
  defineMethod({
    name: 'projectTask.reviewSubmit',
    permission: 'workspace',
    params: TaskReviewSubmission,
    handler: async (params, context) => {
      requireTaskDelegationCapability(context, params.capability)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      const task = await resources.workspace.show(params.id)
      const actor = projectTaskDelegationContext(context, resources, params.from)
      const replay = readDelegationMutation(
        resources.store,
        resources.projectId,
        'review.submit',
        params.requestId,
        actor.actor.key,
        params
      )
      if (replay) {
        return {
          receipt: replay,
          workflow: projectTaskWorkflow(resources.store, resources.projectId, task, false, actor)
        }
      }
      await verifyProjectTaskResultSource(
        context,
        resources,
        await resources.workspace.show(params.id),
        params.resultDigest
      )
      let receipt: unknown
      const workflow = await taskWorkflowAction(
        context.runtime,
        params,
        (resources) => {
          const actor = projectTaskDelegationContext(context, resources, params.from)
          receipt = resources.store.delegation.mutate(
            resources.projectId,
            'review.submit',
            params.requestId,
            actor.actor.key,
            params,
            () => {
              const review = recordTaskReview(
                resources.store,
                actor,
                params.resultDigest,
                params.reviewerAttempt,
                params.verdict,
                params.report
              )
              return { id: review.id, operation: 'review.submit', generation: null }
            }
          )
        },
        (resources) => projectTaskDelegationContext(context, resources, params.from)
      )
      return { receipt, workflow }
    }
  }),
  defineMethod({
    name: 'projectTask.decideDelegated',
    permission: 'workspace',
    params: TaskDelegatedDecision,
    handler: async (params, context) => {
      requireTaskDelegationCapability(context, params.capability)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      const task = await resources.workspace.show(params.id)
      const actor = projectTaskDelegationContext(context, resources, params.from)
      const replay = readDelegationMutation(
        resources.store,
        resources.projectId,
        'result.decideDelegated',
        params.requestId,
        actor.actor.key,
        { context: actor, taskId: task.id, ...params, revision: task.revision }
      )
      if (replay) {
        return {
          receipt: replay,
          workflow: projectTaskWorkflow(resources.store, resources.projectId, task, false, actor)
        }
      }
      await verifyProjectTaskResultSource(
        context,
        resources,
        await resources.workspace.show(params.id),
        params.resultDigest
      )
      let receipt: unknown
      const workflow = await taskWorkflowAction(
        context.runtime,
        params,
        (resources, task) => {
          receipt = decideDelegatedResult(
            resources.store,
            projectTaskDelegationContext(context, resources, params.from),
            task,
            params,
            resources.snapshot.tasks.filter(
              (entry) => entry.parent === task.id || task.depends_on.includes(entry.id)
            )
          )
        },
        (resources) => projectTaskDelegationContext(context, resources, params.from)
      )
      return { receipt, workflow }
    }
  })
]
