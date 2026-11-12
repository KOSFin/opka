import { PROJECT_TASK_CONFIG_PATH } from '../../shared/project-task-contract'
import {
  PROJECT_TASK_DELEGATION_CAPABILITY,
  PROJECT_TASK_PROJECT_AGENTS_CAPABILITY
} from '../../shared/project-task-delegation'
import type { RpcContext } from './rpc/core'
import { getPublishedHostDescriptor } from './host-descriptor'
import { taskRevision } from '../project-tasks/task-document'
import { readTaskTextSync } from '../project-tasks/task-file-boundary'
import { projectTaskResources, taskWorkflowAction } from './project-task-workflow-service'
import { resolveProjectTaskWorkspace } from './project-task-workspaces'
import { currentTaskSessionWorkspaceId } from './project-task-attempt-source'
import { taskSessionCaller } from './project-task-session'
import { resolveProjectTaskActor } from './project-task-actor'
import type { DelegationContext } from '../project-tasks/task-delegation-policy'

type Resources = Awaited<ReturnType<typeof projectTaskResources>>
const verifiedCallerProjects = new WeakMap<
  RpcContext,
  { workspaceId: string; projectId: string; root: string }
>()

export async function verifyProjectTaskCallerProject(
  context: RpcContext,
  resources: Resources,
  from?: string
): Promise<void> {
  if (resources.store.delegation.read(resources.projectId).grant?.schema !== 2) {
    return
  }
  const workspaceId = currentTaskSessionWorkspaceId(context, from)
  if (!workspaceId) {
    throw new Error('Delegated caller has no verified local project placement')
  }
  const caller = await resolveProjectTaskWorkspace(context.runtime, workspaceId, 'local')
  if (
    caller.root !== resources.root ||
    (await caller.workspace.snapshot()).project.id !== resources.projectId
  ) {
    throw new Error('Delegated caller belongs to another project')
  }
  verifiedCallerProjects.set(context, {
    workspaceId,
    projectId: resources.projectId,
    root: resources.root
  })
}

export async function projectTaskDelegationResources(
  context: RpcContext,
  selector: string,
  expectedHost: string,
  from?: string
): Promise<Resources> {
  const resources = await projectTaskResources(context.runtime, selector, expectedHost)
  await verifyProjectTaskCallerProject(context, resources, from)
  return resources
}
export async function delegatedTaskWorkflowAction(
  context: RpcContext,
  params: Parameters<typeof taskWorkflowAction>[1] & { from?: string },
  operation: Parameters<typeof taskWorkflowAction>[2],
  authorizationContext?: Parameters<typeof taskWorkflowAction>[3]
) {
  await projectTaskDelegationResources(
    context,
    params.worktree,
    params.expectedExecutionHostId,
    params.from
  )
  return taskWorkflowAction(context.runtime, params, operation, authorizationContext)
}

export function requireTaskDelegationCapability(context: RpcContext, declared?: string): void {
  if (context.caller?.kind === 'local-cli' && declared === PROJECT_TASK_DELEGATION_CAPABILITY) {
    return
  }
  if (
    declared === PROJECT_TASK_PROJECT_AGENTS_CAPABILITY &&
    context.clientCapabilities?.includes(PROJECT_TASK_PROJECT_AGENTS_CAPABILITY)
  ) {
    return
  }
  if (
    declared === PROJECT_TASK_DELEGATION_CAPABILITY &&
    context.clientCapabilities?.includes(PROJECT_TASK_DELEGATION_CAPABILITY)
  ) {
    return
  }
  throw new Error(
    'Project delegation is unsupported by this client; no legacy approval fallback is available'
  )
}
export function projectTaskBinding(context: Pick<RpcContext, 'runtime'>, resources: Resources) {
  const descriptor = getPublishedHostDescriptor(context.runtime.getRuntimeId())
  if (!descriptor?.machineBinding) {
    throw new Error(
      'Project delegation requires a verified owning host installation and machine binding'
    )
  }
  return {
    installationId: descriptor.installationId,
    machineBinding: descriptor.machineBinding,
    projectId: resources.projectId,
    root: resources.root,
    configRevision: taskRevision(readTaskTextSync(resources.root, PROJECT_TASK_CONFIG_PATH))
  }
}
export function projectTaskDelegationContext(
  context: RpcContext,
  resources: Resources,
  from?: string
): DelegationContext {
  const { caller } = taskSessionCaller(context, from)
  const actor = resolveProjectTaskActor(context.runtime, caller.address)
  let callerProjectId: string | undefined
  if (resources.store.delegation.read(resources.projectId).grant?.schema === 2) {
    const verified = verifiedCallerProjects.get(context)
    if (
      !verified ||
      verified.workspaceId !== currentTaskSessionWorkspaceId(context, from) ||
      verified.projectId !== resources.projectId ||
      verified.root !== resources.root
    ) {
      throw new Error('Delegated caller project placement changed or was not verified')
    }
    callerProjectId = verified.projectId
  }
  const run = resources.store.native.getCurrentRunForCoordinator(caller)
  return {
    binding: projectTaskBinding(context, resources),
    actor,
    runId: run?.id ?? null,
    callerProjectId
  }
}
export function optionalProjectTaskDelegationContext(
  context: RpcContext,
  resources: Resources,
  from?: string,
  declared?: string
): DelegationContext | undefined {
  if (
    !context.clientCapabilities?.includes(PROJECT_TASK_DELEGATION_CAPABILITY) &&
    !(context.caller?.kind === 'local-cli' && declared === PROJECT_TASK_DELEGATION_CAPABILITY)
  ) {
    return undefined
  }
  return projectTaskDelegationContext(context, resources, from)
}
