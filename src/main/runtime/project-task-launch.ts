import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { z } from 'zod'
import { WorkerStartParams } from '../../shared/rpc-contract/orchestration-worker-start-params'
import type { ProjectTaskStart } from '../../shared/rpc-contract/project-task-workflow-params'
import type { RpcContext } from './rpc/core'
import { projectTaskResources } from './project-task-workflow-service'
import { resolveOrchestrationCaller } from './rpc/methods/orchestration/runs/run-scope'
import { ORCHESTRATION_WORKER_START_METHODS } from './rpc/methods/orchestration/worker/workers'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { requireLocalRuntimeFileRoute } from './files/file-target'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './rpc/methods/orchestration/worker/worker-start-prompt-budget'
import { projectTaskAttemptSpec } from '../project-tasks/task-attempt-spec'
import { projectTaskRepositories } from '../../shared/project-task-placement'

export async function startProjectTask(
  params: z.infer<typeof ProjectTaskStart>,
  context: RpcContext
) {
  if (params.launch.on || params.launch.retryOf || !params.launch.worktree) {
    throw new Error(
      'Project tasks require an explicit placement on their owning host; federation/retry-of is managed separately'
    )
  }
  const resources = await projectTaskResources(
    context.runtime,
    params.worktree,
    params.expectedExecutionHostId
  )
  const { store, projectId, workspace, root } = resources
  const coordinator = resolveOrchestrationCaller(context.runtime, {
    callerTerminalHandle: params.launch.from,
    callerEvidence: context.orchestrationCompatibilityEvidence,
    callerSession: context.orchestrationCaller
  })
  const run = coordinator ? store.native.getCurrentRunForCoordinator(coordinator) : undefined
  if (!run || (params.launch.run && params.launch.run !== run.id)) {
    throw new Error(
      'Start requires a coordinator currently bound to its Run; create or resume the Run in that agent first'
    )
  }
  const task = await workspace.show(params.id)
  await assertWorkerStartTaskSpecWithinPromptBudget(projectTaskAttemptSpec(root, task))
  const repos = context.runtime.listRepos()
  const placement = params.launch.worktree
  const workspaceTarget = ['new-child', 'new-top-level'].includes(placement)
    ? null
    : await context.runtime.resolveRuntimeFileTarget(placement)
  if (workspaceTarget) {
    requireLocalRuntimeFileRoute(workspaceTarget)
  }
  const repo = workspaceTarget
    ? repos.find(
        (entry) =>
          entry.id === workspaceTarget.worktree.repoId &&
          getRepoExecutionHostId(entry) === workspaceTarget.executionHostId
      )
    : repos.find(
        (entry) => entry.id === params.launch.repo && getRepoExecutionHostId(entry) === 'local'
      )
  const candidate = repo?.path ?? workspaceTarget?.worktree.path
  if (
    !candidate ||
    !projectTaskRepositories(task, resources.snapshot.project).some((alias) => {
      const base = resolve(root, resources.snapshot.project.repos[alias])
      const path = relative(base, resolve(candidate))
      return !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
    })
  ) {
    throw new Error('Worker placement does not belong to a repository in this task scope')
  }
  const attempt = await workspace.withTaskRevision(
    params.id,
    params.revision,
    async (current, snapshot) =>
      store.transaction(() =>
        store.prepare(
          projectId,
          current,
          run.id,
          snapshot.tasks.filter((entry) => current.depends_on.includes(entry.id))
        )
      )
  )
  try {
    const result = await ORCHESTRATION_WORKER_START_METHODS[0].handler(
      WorkerStartParams.parse({
        ...params.launch,
        spec: undefined,
        task: attempt.nativeTask.id,
        run: run.id
      }),
      {
        ...context,
        projectTaskAdmission: { nativeTaskId: attempt.nativeTask.id, attemptId: attempt.id }
      }
    )
    workspace.notifyChanged()
    return { attemptId: attempt.id, result }
  } catch (error) {
    const dispatch = store.native.db
      .prepare('SELECT id FROM dispatch_contexts WHERE task_id=? LIMIT 1')
      .get(attempt.nativeTask.id)
    if (!dispatch && store.native.getTask(attempt.nativeTask.id)?.status === 'ready') {
      store.native.updateTaskStatus(
        attempt.nativeTask.id,
        'failed',
        'Start failed before any Dispatch materialized'
      )
    }
    store.event(
      projectId,
      task,
      'attempt.start_error',
      'Start did not return a ready receipt. Inspect the exact runtime attempt before retrying.'
    )
    workspace.notifyChanged()
    throw error
  }
}
