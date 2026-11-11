import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import type { Repo } from '../../../../shared/repo-types'
import { isProjectGroupJoinableFromCatalog } from '../slices/project-group-owner-routing'
import { isSameRepoRow } from '../slices/repo-host-identity'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { adoptFromEndpoint } from '../adopt-from-endpoint'
import { mergeProjectCompatibilityForHostRepoChange } from '../repos/repo-catalog-identity'
import { notifyProjectGroupOnOtherHost } from './project-group-host-notice'

export function createMoveProjectToGroup(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['moveProjectToGroup'] {
  return async (project, groupId, order) => {
    try {
      const repo = get().repos.find((candidate) => isSameRepoRow(candidate, project))
      const repoHostId = repo ? getRepoExecutionHostId(repo) : null
      const target = repoHostId ? ipcOrRuntimeTargetForHostId(repoHostId) : null
      if (!repo || !repoHostId || !target) {
        return false
      }
      if (groupId && !isProjectGroupJoinableFromCatalog(get().projectGroups, groupId, target)) {
        notifyProjectGroupOnOtherHost()
        return false
      }
      const moved =
        target.kind === 'local'
          ? await window.api.projectGroups.moveProject({
              projectId: repo.id,
              groupId,
              order,
              hostId: repoHostId
            })
          : (
              await callRuntimeRpc<{ repo: Repo | null }>(
                target,
                'projectGroup.moveProject',
                // Why connectionId: the server's own twins differ only by their SSH target there.
                { repo: repo.id, groupId, order, connectionId: repo.connectionId ?? null },
                { timeoutMs: 15_000 }
              )
            ).repo
      if (!moved) {
        return false
      }
      const ownedMoved = adoptFromEndpoint(target, { kind: 'repo', row: moved })
      const movedHostId = getRepoExecutionHostId(ownedMoved)
      set((s) => {
        const nextRepos = s.repos.map((candidate) =>
          isSameRepoRow(candidate, repo) ? ownedMoved : candidate
        )
        return {
          repos: nextRepos,
          ...mergeProjectCompatibilityForHostRepoChange({
            previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
            nextRepos,
            hostId: movedHostId
          }),
          folderWorkspacePathStatuses: {}
        }
      })
      // Why: hosts store an unknown group id as "no group" and still return the row (#13699).
      if (groupId && (moved.projectGroupId ?? null) !== groupId) {
        notifyProjectGroupOnOtherHost()
        return false
      }
      return true
    } catch (err) {
      console.error('Failed to move repo to group:', err)
      return false
    }
  }
}
