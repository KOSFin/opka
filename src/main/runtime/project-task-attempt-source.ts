import { readAgentSessionRecordStore } from './orchestration/structured-session-lineage'
import { realpath } from 'node:fs/promises'
import { delegationDigest } from '../project-tasks/task-delegation-policy'
import {
  readTaskSessionPlacement,
  type AttemptPlacement
} from '../project-tasks/task-attempt-placement'
import { taskAttemptAuthor, taskAttemptDispatchId } from '../project-tasks/task-result-authors'
import type { TaskWorkflowStore } from '../project-tasks/task-workflow-store'
import type { RpcContext } from './rpc/core'
import { taskSessionCaller } from './project-task-session'
import { resolveProjectTaskActor } from './project-task-actor'
import { requireLocalRuntimeFileRoute } from './files/file-target'

export function currentTaskSessionWorkspaceId(context: RpcContext, from?: string): string | null {
  const { caller } = taskSessionCaller(context, from)
  if (context.orchestrationCaller) {
    const record = readAgentSessionRecordStore()?.getRecord(context.orchestrationCaller.sessionId)
    return record?.location.executionHostId === 'local' && record.location.wslDistro === null
      ? record.location.workspaceId
      : null
  }
  const authority = caller.terminalHandle
    ? context.runtime.getOrchestrationDispatchAuthority(caller.terminalHandle)
    : null
  return authority?.hostScope.kind === 'local' ? authority.worktreeId : null
}

export async function projectTaskSessionPlacement(context: RpcContext, from?: string) {
  const { caller } = taskSessionCaller(context, from)
  const workspaceId = currentTaskSessionWorkspaceId(context, from)
  if (!workspaceId) {
    return null
  }
  const target = await context.runtime.resolveRuntimeFileTarget(workspaceId)
  // Non-code folder/manual attempts need no delegated source proof.
  if (target.executionHostId !== 'local') {
    return null
  }
  requireLocalRuntimeFileRoute(target)
  return {
    workspaceId,
    executionHostId: 'local' as const,
    worktreePath: await realpath(target.worktree.path),
    owner: resolveProjectTaskActor(context.runtime, caller.address)
  }
}

export async function projectTaskAttemptSource(
  context: Pick<RpcContext, 'runtime'>,
  store: TaskWorkflowStore,
  attemptId: string
): Promise<AttemptPlacement> {
  const dispatchId = taskAttemptDispatchId(store, attemptId)
  if (!dispatchId) {
    return readTaskSessionPlacement(store, attemptId)
  }
  const dispatch = store.native.getDispatchContextById(dispatchId)
  const worker = store.native.getWorkerDispatch(dispatchId)
  if (
    !dispatch ||
    dispatch.status !== 'completed' ||
    store.native.getFederatedDispatch(dispatchId) ||
    !worker?.worktree_id ||
    worker.state !== 'succeeded'
  ) {
    throw new Error(
      'Settled owning-host Dispatch placement provenance is unavailable; SSH proof is unsupported'
    )
  }
  const target = await context.runtime.resolveRuntimeFileTarget(worker.worktree_id)
  requireLocalRuntimeFileRoute(target)
  return {
    workspaceId: worker.worktree_id,
    executionHostId: 'local',
    worktreePath: await realpath(target.worktree.path),
    owner: taskAttemptAuthor(store, attemptId)
  }
}

export function taskSourcePlacementDigest(attemptId: string, placement: AttemptPlacement): string {
  return delegationDigest({ attemptId, ...placement })
}
