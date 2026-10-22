import { beforeEach, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { makeFolderWorkspace } from '@/components/worktree-jump-palette-test-fixtures'
import { getOrCreateProjectFolder } from './open-project-folder'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealFolderWorkspace: vi.fn() }))

const group: ProjectGroup = {
  id: 'project',
  name: 'Project',
  parentPath: '/project',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

beforeEach(() => vi.clearAllMocks())

it('opens an existing project session without asking to create one', async () => {
  const folder = makeFolderWorkspace({ projectGroupId: group.id, folderPath: '/project' })
  const createFolderWorkspace = vi.fn()
  mocks.getState.mockReturnValue({
    folderWorkspaces: [folder],
    projectGroups: [group],
    createFolderWorkspace
  })
  expect(await getOrCreateProjectFolder(group)).toBe(folder)
  expect(createFolderWorkspace).not.toHaveBeenCalled()
})

it('registers the root once on its owning remote runtime, not the active host', async () => {
  const remote = { ...group, executionHostId: 'runtime:remote' }
  const folder = makeFolderWorkspace({
    projectGroupId: group.id,
    folderPath: '/project',
    executionHostId: 'runtime:remote'
  })
  const createFolderWorkspace = vi.fn().mockResolvedValue(folder)
  mocks.getState.mockReturnValue({
    folderWorkspaces: [],
    projectGroups: [remote],
    createFolderWorkspace
  })
  const results = await Promise.all([
    getOrCreateProjectFolder(remote),
    getOrCreateProjectFolder(remote)
  ])
  expect(results).toEqual([folder, folder])
  expect(createFolderWorkspace).toHaveBeenCalledExactlyOnceWith(
    { projectGroupId: 'project', folderPath: '/project', name: 'Project session' },
    { runtimeEnvironmentId: 'remote' }
  )
})

it('never silently creates a local session for a direct SSH owner', async () => {
  const createFolderWorkspace = vi.fn()
  mocks.getState.mockReturnValue({ folderWorkspaces: [], projectGroups: [], createFolderWorkspace })
  await expect(
    getOrCreateProjectFolder({ ...group, executionHostId: 'ssh:legacy' })
  ).rejects.toThrow('owning Orca runtime')
  expect(createFolderWorkspace).not.toHaveBeenCalled()
})
