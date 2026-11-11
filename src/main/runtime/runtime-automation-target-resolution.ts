import type { Automation, AutomationWorkspaceMode } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'

export type RuntimeAutomationTargetResolvers = {
  showRepo: (selector: string) => Promise<Repo>
  showManagedWorktree: (selector: string) => Promise<Pick<Worktree, 'id' | 'repoId' | 'path'>>
}

export async function resolveRuntimeAutomationTarget(
  resolvers: RuntimeAutomationTargetResolvers,
  input: {
    repo?: string
    workspace?: string
    workspaceMode?: AutomationWorkspaceMode
    baseBranch?: string | null
  },
  current?: Automation
): Promise<{
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  repo: Repo | null
}> {
  const hasRepo = input.repo !== undefined
  const hasWorkspace = input.workspace !== undefined
  if (
    current?.workspaceMode === 'existing' &&
    hasRepo &&
    !hasWorkspace &&
    input.workspaceMode !== 'new_per_run'
  ) {
    throw new Error(
      'Repo updates for existing-workspace automation require workspaceMode new_per_run.'
    )
  }
  const workspace = input.workspace ? await resolvers.showManagedWorktree(input.workspace) : null
  const repoSelector =
    input.repo ??
    (workspace?.repoId
      ? `id:${workspace.repoId}`
      : current?.projectId
        ? `id:${current.projectId}`
        : null)
  const repo = repoSelector ? await resolvers.showRepo(repoSelector) : null
  const workspaceMode =
    input.workspaceMode ??
    (workspace
      ? 'existing'
      : input.repo && !current
        ? 'new_per_run'
        : (current?.workspaceMode ?? 'new_per_run'))
  if (workspaceMode === 'existing') {
    const workspaceId = workspace?.id ?? current?.workspaceId
    const projectId = workspace?.repoId ?? current?.projectId
    if (repo && repo.id !== projectId) {
      throw new Error('Selected workspace belongs to a different repo.')
    }
    if (!workspaceId || !projectId) {
      throw new Error('Existing-workspace automation requires --workspace.')
    }
    return { projectId, workspaceMode, workspaceId, repo }
  }
  const projectId = repo?.id ?? workspace?.repoId ?? current?.projectId
  if (!projectId) {
    throw new Error('Automation requires --repo or --workspace.')
  }
  return { projectId, workspaceMode: 'new_per_run', workspaceId: null, repo }
}
