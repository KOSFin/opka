import { requireTaskSourcePlacement } from '../project-tasks/task-attempt-placement'
import { taskAttemptDispatchId, taskAttemptAuthor } from '../project-tasks/task-result-authors'
import { delegationDigest } from '../project-tasks/task-delegation-policy'
import { realpath } from 'node:fs/promises'
import { projectTaskAttemptSource, taskSourcePlacementDigest } from './project-task-attempt-source'
import { readTaskResult } from '../project-tasks/task-result-evidence'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RpcContext } from './rpc/core'
import type { projectTaskResources } from './project-task-workflow-service'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import { projectTaskRepositories } from '../../shared/project-task-placement'
import { requireLocalRuntimeFileRoute } from './files/file-target'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'

// These read-only commands and options all predate the Git 2.25 baseline.
async function projectTaskSourceOptions(
  context: Pick<RpcContext, 'runtime'>,
  resources: Awaited<ReturnType<typeof projectTaskResources>>,
  task: ProjectTaskEntry,
  selector: string
) {
  const target = await context.runtime.resolveRuntimeFileTarget(selector)
  requireLocalRuntimeFileRoute(target)
  const repo = context.runtime
    .listRepos()
    .find(
      (entry) =>
        entry.id === target.worktree.repoId &&
        getRepoExecutionHostId(entry) === target.executionHostId
    )
  const candidate = repo?.path ?? target.worktree.path
  if (
    !projectTaskRepositories(task, resources.snapshot.project).some((alias) => {
      const offset = relative(
        resolve(resources.root, resources.snapshot.project.repos[alias]),
        resolve(candidate)
      )
      return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
    })
  ) {
    throw new Error('Source working copy is outside the task repository scope')
  }
  return { cwd: target.worktree.path, maxBuffer: 1024 * 1024, timeout: 10_000 }
}

export async function projectTaskCodeSnapshot(
  context: Pick<RpcContext, 'runtime'>,
  resources: Awaited<ReturnType<typeof projectTaskResources>>,
  task: ProjectTaskEntry,
  selector: string,
  attemptId: string
) {
  const placement = await projectTaskAttemptSource(context, resources.store, attemptId)
  const options = await projectTaskSourceOptions(context, resources, task, selector)
  if ((await realpath(options.cwd)) !== placement.worktreePath) {
    throw new Error('Source working copy does not match the settled attempt execution placement')
  }
  const status = await gitExecFileAsync(
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    options
  )
  if (status.stdout.trim()) {
    throw new Error(
      'Delegated code acceptance currently requires a clean committed source snapshot; save a commit or use genuine manual review'
    )
  }
  const commit = (
    await gitExecFileAsync(['rev-parse', '--verify', 'HEAD^{commit}'], options)
  ).stdout.trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error('Source commit is unverifiable')
  }
  const tree = (
    await gitExecFileAsync(['rev-parse', '--verify', `${commit}^{tree}`], options)
  ).stdout.trim()
  if (!/^[a-f0-9]{40,64}$/.test(tree)) {
    throw new Error('Source tree is unverifiable')
  }
  const after = await gitExecFileAsync(
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    options
  )
  const head = (
    await gitExecFileAsync(['rev-parse', '--verify', 'HEAD^{commit}'], options)
  ).stdout.trim()
  if (after.stdout.trim() || head !== commit) {
    throw new Error('Source changed while recording its snapshot')
  }
  return {
    commit,
    tree,
    dirtyDigest: null,
    worktreePath: placement.worktreePath,
    workspaceId: placement.workspaceId,
    placementDigest: taskSourcePlacementDigest(attemptId, placement)
  }
}

export async function verifyProjectTaskResultSource(
  context: Pick<RpcContext, 'runtime'>,
  resources: Awaited<ReturnType<typeof projectTaskResources>>,
  task: ProjectTaskEntry,
  resultDigest: string
): Promise<void> {
  const result = readTaskResult(resources.store, resultDigest)
  if (result.kind !== 'code') {
    return
  }
  if (!result.source || result.source.dirtyDigest !== null || !result.source.placementDigest) {
    throw new Error('Code source evidence is unsupported or missing')
  }
  if (
    result.dispatchId !== taskAttemptDispatchId(resources.store, result.attemptId) ||
    delegationDigest(result.author) !==
      delegationDigest(taskAttemptAuthor(resources.store, result.attemptId))
  ) {
    throw new Error('Retained source author or winning Dispatch provenance changed')
  }
  requireTaskSourcePlacement(resources.store, result.attemptId, result.source)
  const placement = await projectTaskAttemptSource(context, resources.store, result.attemptId)
  if (
    taskSourcePlacementDigest(result.attemptId, placement) !== result.source.placementDigest ||
    placement.worktreePath !== result.source.worktreePath
  ) {
    throw new Error('Retained source placement or owner provenance changed')
  }
  const options = await projectTaskSourceOptions(
    context,
    resources,
    task,
    `path:${result.source.worktreePath}`
  )
  if ((await realpath(options.cwd)) !== placement.worktreePath) {
    throw new Error('Retained source execution placement changed')
  }
  const tree = (
    await gitExecFileAsync(['rev-parse', '--verify', `${result.source.commit}^{tree}`], options)
  ).stdout.trim()
  if (tree !== result.source.tree) {
    throw new Error('Retained source commit/tree evidence is missing or changed')
  }
}
