import { PROJECT_TASK_CONFIG_PATH } from '../../shared/project-task-contract'
import { PROJECT_TASK_DELEGATION_CAPABILITY } from '../../shared/project-task-delegation'
import type { RpcContext } from './rpc/core'
import { getPublishedHostDescriptor } from './host-descriptor'
import { taskRevision } from '../project-tasks/task-document'
import { readTaskTextSync } from '../project-tasks/task-file-boundary'
import type { projectTaskResources } from './project-task-workflow-service'
import { taskSessionCaller } from './project-task-session'
import { resolveProjectTaskActor } from './project-task-actor'
import type { DelegationContext } from '../project-tasks/task-delegation-policy'

type Resources = Awaited<ReturnType<typeof projectTaskResources>>
export function requireTaskDelegationCapability(context: RpcContext, declared?: string): void {
  if (context.caller?.kind === 'local-cli' && declared === PROJECT_TASK_DELEGATION_CAPABILITY) {
    return
  }
  if (!context.clientCapabilities?.includes(PROJECT_TASK_DELEGATION_CAPABILITY)) {
    throw new Error(
      'Project delegation is unsupported by this client; no legacy approval fallback is available'
    )
  }
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
  const run = resources.store.native.getCurrentRunForCoordinator(caller)
  return { binding: projectTaskBinding(context, resources), actor, runId: run?.id ?? null }
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
