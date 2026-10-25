import type { OrcaRuntimeService } from './orca-runtime'
import { requireLocalRuntimeFileRoute } from './files/file-target'
import { watchFileExplorerInWatcherProcess } from './file-watcher-host'
import { TaskWorkspace } from '../project-tasks/task-workspace'
import { resolveRegisteredTaskRoot } from '../project-tasks/task-project-roots'
import { resolveProjectTaskTarget } from './project-task-target'

const workspaces = new WeakMap<OrcaRuntimeService, Map<string, TaskWorkspace>>()

export async function closeProjectTaskWorkspaces(runtime: OrcaRuntimeService): Promise<void> {
  const cache = workspaces.get(runtime)
  workspaces.delete(runtime)
  await Promise.all([...(cache?.values() ?? [])].map((workspace) => workspace.close()))
}

export async function resolveProjectTaskWorkspace(
  runtime: OrcaRuntimeService,
  selector: string,
  expectedHost?: string
) {
  const { target, selectedPath } = await resolveProjectTaskTarget(runtime, selector, expectedHost)
  if (expectedHost !== undefined && expectedHost !== target.executionHostId) {
    throw new Error('Workspace host changed; refresh before writing project tasks')
  }
  requireLocalRuntimeFileRoute(target)
  const root = await resolveRegisteredTaskRoot(runtime, selectedPath)
  let cache = workspaces.get(runtime)
  if (!cache) {
    cache = new Map()
    workspaces.set(runtime, cache)
  }
  let workspace = cache.get(root)
  if (!workspace) {
    let evicted: TaskWorkspace | undefined
    if (cache.size >= 16) {
      const oldest = [...cache.entries()].find(([, entry]) => !entry.subscribed)
      if (!oldest) {
        throw new Error('Close an inactive project task view before opening another source')
      }
      if (oldest) {
        cache.delete(oldest[0])
        evicted = oldest[1]
      }
    }
    workspace = new TaskWorkspace(root, (path, changed, failed) =>
      watchFileExplorerInWatcherProcess(
        path,
        (events) => {
          changed(
            events.some((event) => event.kind === 'overflow' || event.isDirectory)
              ? null
              : events.map((event) => event.absolutePath)
          )
        },
        failed
      )
    )
    cache.set(root, workspace)
    await evicted?.close()
  } else {
    cache.delete(root)
    cache.set(root, workspace)
  }
  return { workspace, executionHostId: target.executionHostId, root }
}
