import { resumeProjectTask } from '../../project-task-resume'
import { defineMethod } from '../core'
import {
  TaskPolicyTarget,
  TaskDelegationRead,
  TaskPolicyPropose,
  TaskPolicyConfirm,
  TaskDelegatedApproval
} from '../../../../shared/rpc-contract/project-task-delegation-params'
import {
  projectTaskResources,
  requireInteractiveTaskOperator,
  taskWorkflowAction
} from '../../project-task-workflow-service'
import {
  projectTaskBinding,
  projectTaskDelegationContext,
  requireTaskDelegationCapability
} from '../../project-task-delegation'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { delegationDigest } from '../../../project-tasks/task-delegation-policy'
import { resolveProjectTaskActor } from '../../project-task-actor'
import {
  TaskDelegationAction,
  PROJECT_TASK_PROJECT_AGENTS_CAPABILITY
} from '../../../../shared/project-task-delegation'

function requireProjectPolicyCapability(capability: string, grantSchema: number | undefined): void {
  if (grantSchema === 2 && capability !== PROJECT_TASK_PROJECT_AGENTS_CAPABILITY) {
    throw new Error('Project agent policy requires an updated client; no manual state was assumed')
  }
}

export const PROJECT_TASK_DELEGATION_METHODS = [
  defineMethod({
    name: 'projectTask.resumeDelegated',
    permission: 'workspace',
    params: TaskDelegationRead,
    handler: async (params, context) => {
      requireTaskDelegationCapability(context, params.capability)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      return resumeProjectTask(
        context.runtime,
        params.worktree,
        params.id,
        projectTaskDelegationContext(context, resources, params.from)
      )
    }
  }),
  defineMethod({
    name: 'projectTask.policy.read',
    permission: 'workspace',
    params: TaskPolicyTarget,
    handler: async (params, context) => {
      requireTaskDelegationCapability(context, params.capability)
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      const policy = resources.store.delegation.read(resources.projectId)
      requireProjectPolicyCapability(params.capability, policy.grant?.schema)
      return policy
    }
  }),
  defineMethod({
    name: 'projectTask.policy.propose',
    permission: 'workspace',
    params: TaskPolicyPropose,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      requireTaskDelegationCapability(context, params.capability)
      const caller = context.caller
      const connection = context.connectionId
      if (!caller || !connection) {
        throw new Error('Authenticated policy connection is required')
      }
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      await context.runtime.ensureStructuredAgentSessionHost()
      return resources.workspace.withSnapshot(async (snapshot) => {
        if (snapshot.project.id !== resources.projectId) {
          throw new Error('Project identity changed before policy mutation')
        }
        return resources.store.transaction(() => {
          requireProjectPolicyCapability(
            params.capability,
            resources.store.delegation.read(resources.projectId).grant?.schema
          )
          if (
            params.grant &&
            'mode' in params.grant &&
            params.capability !== PROJECT_TASK_PROJECT_AGENTS_CAPABILITY
          ) {
            throw new Error('Project-wide delegation requires a capable client and execution host')
          }
          const grant = params.grant
            ? 'mode' in params.grant
              ? {
                  schema: 2 as const,
                  binding: projectTaskBinding(context, resources),
                  scope: 'project-agents' as const,
                  actions: [...TaskDelegationAction.options],
                  expiresAt: null,
                  generation: params.expectedGeneration + 1
                }
              : {
                  schema: 1 as const,
                  binding: projectTaskBinding(context, resources),
                  actor: resolveProjectTaskActor(context.runtime, params.grant.grantee),
                  actorAddress: params.grant.grantee,
                  actions: params.grant.actions,
                  runId: params.grant.runId,
                  taskIds: params.grant.taskIds,
                  expiresAt: params.grant.expiresAt,
                  generation: params.expectedGeneration + 1
                }
            : null
          if (grant?.schema === 1 && grant.runId && !resources.store.native.getRun(grant.runId)) {
            throw new Error('Unknown grantee Run')
          }
          return resources.store.delegation.propose(
            resources.projectId,
            `${caller.kind}:${rpcCallerOperationKey(caller)}`,
            connection,
            params.expectedGeneration,
            grant,
            projectTaskBinding(context, resources)
          )
        }, resources.workspace.fileBoundary(snapshot))
      })
    }
  }),
  defineMethod({
    name: 'projectTask.policy.confirm',
    permission: 'workspace',
    params: TaskPolicyConfirm,
    handler: async (params, context) => {
      requireInteractiveTaskOperator(context)
      requireTaskDelegationCapability(context, params.capability)
      const caller = context.caller
      const connection = context.connectionId
      if (!caller || !connection) {
        throw new Error('Authenticated policy connection is required')
      }
      const resources = await projectTaskResources(
        context.runtime,
        params.worktree,
        params.expectedExecutionHostId
      )
      await context.runtime.ensureStructuredAgentSessionHost()
      return resources.workspace.withSnapshot(async (snapshot) => {
        if (snapshot.project.id !== resources.projectId) {
          throw new Error('Project identity changed before policy mutation')
        }
        return resources.store.transaction(() => {
          requireProjectPolicyCapability(
            params.capability,
            resources.store.delegation.read(resources.projectId).grant?.schema
          )
          return resources.store.delegation.confirm(
            resources.projectId,
            `${caller.kind}:${rpcCallerOperationKey(caller)}`,
            connection,
            params.proposal,
            params.digest,
            params.requestId,
            projectTaskBinding(context, resources),
            (grant) => {
              if (
                grant.schema === 1 &&
                delegationDigest(resolveProjectTaskActor(context.runtime, grant.actorAddress)) !==
                  delegationDigest(grant.actor)
              ) {
                throw new Error('Grantee identity changed before confirmation')
              }
            }
          )
        }, resources.workspace.fileBoundary(snapshot))
      })
    }
  }),
  defineMethod({
    name: 'projectTask.approveDelegated',
    permission: 'workspace',
    params: TaskDelegatedApproval,
    handler: async (params, context) => {
      requireTaskDelegationCapability(context, params.capability)
      let receipt: unknown
      const workflow = await taskWorkflowAction(
        context.runtime,
        params,
        (resources, task) => {
          receipt = resources.store.delegation.approve(
            projectTaskDelegationContext(context, resources, params.from),
            task,
            params.requestId
          )
        },
        (resources) => projectTaskDelegationContext(context, resources, params.from)
      )
      return { receipt, workflow }
    }
  })
]
