import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  registeredTaskRoots,
  taskRootContains,
  type TaskProjectRootsHost
} from '../project-tasks/task-project-roots'
import { requireLocalRuntimeFileRoute, type ResolvedRuntimeFileTarget } from './files/file-target'

type TaskTargetHost = TaskProjectRootsHost & {
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}

export async function resolveProjectTaskTarget(
  host: TaskTargetHost,
  selector: string,
  expectedHost?: string
): Promise<{ target: ResolvedRuntimeFileTarget; selectedPath: string }> {
  try {
    const target = await host.resolveRuntimeFileTarget(selector)
    return { target, selectedPath: target.worktree.path }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== 'selector_not_found' ||
      !selector.startsWith('path:') ||
      !isAbsolute(selector.slice(5)) ||
      (expectedHost !== undefined && expectedHost !== 'local')
    ) {
      throw error
    }
    const selectedPath = await realpath(selector.slice(5))
    const candidates: { selector: string; root: string }[] = []
    for (const entry of registeredTaskRoots(host).slice(0, 256)) {
      let root: string
      try {
        root = await realpath(entry.root)
      } catch {
        continue
      }
      if (taskRootContains(root, selectedPath)) {
        candidates.push({ selector: entry.selector, root })
      }
    }
    candidates.sort((a, b) => b.root.length - a.root.length)
    const match = candidates[0]
    if (!match) {
      throw error
    }
    // Re-resolve the registration so host and path availability checks remain authoritative.
    const target = await host.resolveRuntimeFileTarget(match.selector)
    requireLocalRuntimeFileRoute(target)
    const resolvedRoot = await realpath(target.worktree.path)
    if (resolvedRoot !== match.root || !taskRootContains(resolvedRoot, selectedPath)) {
      throw new Error('Workspace registration changed; refresh before reading project tasks')
    }
    return { target, selectedPath }
  }
}
