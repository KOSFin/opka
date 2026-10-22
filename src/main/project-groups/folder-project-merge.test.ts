import { expect, it } from 'vitest'
import { createProjectGroup } from '../../shared/project-groups'
import { mergeFolderProjectGroups } from './folder-project-merge'

function fixture() {
  const manual = createProjectGroup({
    name: 'Project',
    parentPath: '/old-fixture',
    createdFrom: 'manual',
    tabOrder: 0
  })
  const scan = createProjectGroup({
    name: 'Project',
    parentPath: '/project',
    createdFrom: 'folder-scan',
    tabOrder: 1
  })
  const child = createProjectGroup({
    name: 'apps',
    parentPath: '/project/apps',
    parentGroupId: scan.id,
    createdFrom: 'folder-scan',
    tabOrder: 2
  })
  const state = {
    projectGroups: [manual, scan, child],
    folderWorkspaces: [
      { id: 'stable-folder', folderPath: '/project', projectGroupId: manual.id, notes: 'keep' }
    ],
    repos: [{ id: 'same-repo', projectGroupId: scan.id, path: '/project/backend' }],
    sessions: ['keep all chat/session identities']
  }
  return { manual, scan, child, state }
}
it('merges only group metadata and preserves folder/repo/session identities and children', () => {
  const { state, scan, manual, child } = fixture()
  const before = structuredClone(state)
  expect(mergeFolderProjectGroups(state, scan.id, manual.id).merged).toBe(true)
  expect(state.projectGroups).toHaveLength(2)
  expect(state.projectGroups.find((group) => group.id === manual.id)?.parentPath).toBe('/project')
  expect(state.projectGroups.find((group) => group.id === child.id)?.parentGroupId).toBe(manual.id)
  expect(state.folderWorkspaces).toEqual(before.folderWorkspaces)
  expect(state.repos).toEqual([{ ...before.repos[0], projectGroupId: manual.id }])
  expect(state.sessions).toEqual(before.sessions)
})
it('refuses different hosts or roots without a partial mutation', () => {
  const { state, scan, manual } = fixture()
  scan.connectionId = 'other-host'
  const before = structuredClone(state)
  expect(() => mergeFolderProjectGroups(state, scan.id, manual.id)).toThrow(/same host/)
  expect(state).toEqual(before)
  scan.connectionId = null
  scan.parentPath = '/another-project'
  const second = structuredClone(state)
  expect(() => mergeFolderProjectGroups(state, scan.id, manual.id)).toThrow(/same project folder/)
  expect(state).toEqual(second)
})
it('refuses ambiguous multi-home groups', () => {
  const { state, scan, manual } = fixture()
  state.folderWorkspaces.push({
    id: 'another',
    folderPath: '/unrelated',
    projectGroupId: manual.id,
    notes: 'keep too'
  })
  expect(() => mergeFolderProjectGroups(state, scan.id, manual.id)).toThrow(
    /multiple project homes/
  )
})
