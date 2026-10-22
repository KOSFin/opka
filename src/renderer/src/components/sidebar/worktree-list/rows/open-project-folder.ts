import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspace-execution-host'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import { toast } from 'sonner'

const pending = new Map<string, Promise<FolderWorkspace>>()

export async function getOrCreateProjectFolder(group: ProjectGroup): Promise<FolderWorkspace> {
  const state = useAppStore.getState()
  const hostId = getProjectGroupHostId(group)
  const folder = state.folderWorkspaces.find(
    (entry) =>
      entry.projectGroupId === group.id &&
      !entry.isArchived &&
      getFolderWorkspaceHostId(entry, state.projectGroups) === hostId &&
      normalizeRuntimePathForComparison(entry.folderPath) ===
        normalizeRuntimePathForComparison(group.parentPath ?? '')
  )
  if (folder) {
    return folder
  }
  const owner = parseExecutionHostId(hostId)
  if (!group.parentPath || !owner || owner.kind === 'ssh') {
    throw new Error('Connect the owning Orca runtime to open this project folder.')
  }
  const key = JSON.stringify([hostId, group.id, group.parentPath])
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const creation = state
    .createFolderWorkspace(
      {
        projectGroupId: group.id,
        folderPath: group.parentPath,
        name: 'Project session'
      },
      { runtimeEnvironmentId: owner.kind === 'runtime' ? owner.environmentId : null }
    )
    .then((created) => {
      if (!created) {
        throw new Error('Project session could not be opened. Reconnect and retry.')
      }
      return created
    })
    .finally(() => pending.delete(key))
  pending.set(key, creation)
  return creation
}

export function openProjectFolder(group: ProjectGroup): void {
  const before = useAppStore.getState()
  const active = before.activeWorktreeId
  const activeHost = before.activeWorkspaceExecutionHostId
  void getOrCreateProjectFolder(group)
    .then((folder) => {
      const current = useAppStore.getState()
      if (
        current.activeWorktreeId !== active ||
        current.activeWorkspaceExecutionHostId !== activeHost
      ) {
        return
      }
      activateAndRevealFolderWorkspace(folder.id, {
        executionHostId: getProjectGroupHostId(group),
        navigationIntent: 'user-open'
      })
    })
    .catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not open project')
    )
}
