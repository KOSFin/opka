import { expect, it } from 'vitest'
import { getFolderProjectRepositories } from './folder-project-repositories'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

function repo(id: string, path: string, executionHostId: ExecutionHostId = 'local'): Repo {
  return { id, path, displayName: id, executionHostId, badgeColor: '', addedAt: 0 }
}

it('shows only registered Git repositories on the folder owner, including nested paths', () => {
  const folder = makeFolderWorkspace({
    id: 'folder',
    folderPath: '/project',
    executionHostId: 'runtime:server'
  })
  const repos = [
    repo('local', '/project/api'),
    repo('remote', '/project/api', 'runtime:server'),
    repo('deep', '/project/apps/web', 'runtime:server'),
    repo('other', '/project-other/api', 'runtime:server'),
    { ...repo('plain', '/project/files', 'runtime:server'), kind: 'folder' as const }
  ]
  expect(
    getFolderProjectRepositories(
      { folderWorkspaces: [folder], projectGroups: [], repos },
      folder
    ).map((r) => r.id)
  ).toEqual(['remote', 'deep'])
})

it('uses Windows path rules rather than the client OS', () => {
  const folder = makeFolderWorkspace({
    id: 'folder',
    folderPath: 'C:\\Work',
    executionHostId: 'local'
  })
  const repos = [repo('inside', 'c:\\work\\backend'), repo('outside', 'C:\\Workspace\\backend')]
  expect(
    getFolderProjectRepositories(
      { folderWorkspaces: [folder], projectGroups: [], repos },
      folder
    ).map((r) => r.id)
  ).toEqual(['inside'])
})

it('does not use a local folder twin when a remote folder has the same ID and a different root', () => {
  const local = makeFolderWorkspace({ id: 'same', folderPath: '/local', executionHostId: 'local' })
  const remote = makeFolderWorkspace({
    id: 'same',
    folderPath: '/remote',
    executionHostId: 'runtime:server'
  })
  const repos = [repo('near', '/local/api'), repo('far', '/remote/api', 'runtime:server')]
  expect(
    getFolderProjectRepositories(
      { folderWorkspaces: [local, remote], projectGroups: [], repos },
      remote
    ).map((entry) => entry.id)
  ).toEqual(['far'])
})
