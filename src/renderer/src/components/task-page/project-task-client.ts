import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ProjectTaskBoard } from '../../../../shared/project-task-board'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { TaskSnapshotCache } from './project-task-snapshot-cache'

const boards = new TaskSnapshotCache<ProjectTaskBoard>()
const boardKey = (target: RuntimeClientTarget, worktree: string) =>
  JSON.stringify([target, worktree])
export const cachedProjectTaskBoard = (target: RuntimeClientTarget, worktree: string) =>
  boards.peek(boardKey(target, worktree))

export type ProjectTaskClient = {
  target: RuntimeClientTarget
  worktree: string
  executionHostId: string
}

export function projectTaskCall<T>(
  client: ProjectTaskClient,
  operation: string,
  params: object = {}
): Promise<T> {
  return callRuntimeRpc<T>(client.target, `projectTask.${operation}`, {
    ...params,
    worktree: client.worktree,
    expectedExecutionHostId: client.executionHostId
  })
}

export async function readProjectTaskBoard(
  target: RuntimeClientTarget,
  worktree: string
): Promise<ProjectTaskBoard> {
  return boards.load(boardKey(target, worktree), () => loadProjectTaskBoard(target, worktree))
}

async function loadProjectTaskBoard(
  target: RuntimeClientTarget,
  worktree: string
): Promise<ProjectTaskBoard> {
  const first = await callRuntimeRpc<ProjectTaskBoard>(target, 'projectTask.board', {
    worktree,
    offset: 0,
    limit: 100
  })
  for (let offset = 100; offset < first.total; offset += 100) {
    const next = await callRuntimeRpc<ProjectTaskBoard>(target, 'projectTask.board', {
      worktree,
      offset,
      limit: 100
    })
    if (next.project.id !== first.project.id || next.executionHostId !== first.executionHostId) {
      throw new Error('Workspace changed during loading; refresh the task view')
    }
    first.tasks.push(...next.tasks)
  }
  return first
}
