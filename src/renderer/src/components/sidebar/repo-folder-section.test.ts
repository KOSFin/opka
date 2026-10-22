import { expect, it } from 'vitest'
import {
  getRepoProjectSectionId,
  getSidebarProjectGroups,
  getProjectRepositoryLabel
} from '../../../../shared/sidebar-list/project-repository-navigation'
import { getGroupKeysForWorktree } from '../../../../shared/sidebar-list/worktree-group-keys'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import type { ProjectGroup } from '../../../../shared/project-group-types'

const root: ProjectGroup = {
  id: 'root',
  name: 'Project',
  parentPath: '/workspace',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const container: ProjectGroup = {
  ...root,
  id: 'embedded',
  name: 'embedded',
  parentPath: '/workspace/embedded',
  parentGroupId: root.id
}

it('lists repositories once under their project, with matching reveal and collapse', () => {
  const parent = {
    ...repo,
    id: 'embedded-repo',
    displayName: 'embedded',
    path: '/workspace/embedded',
    projectGroupId: root.id
  }
  const child = {
    ...repo,
    id: 'module',
    displayName: 'module',
    path: '/workspace/embedded/module',
    projectGroupId: container.id
  }
  const map = new Map([
    [parent.id, parent],
    [child.id, child]
  ])
  const parentCopy = { ...worktree, id: 'parent-copy', repoId: parent.id }
  const copies = [parentCopy, { ...worktree, id: 'child-copy', repoId: child.id }]
  const groups = [root, container]
  expect(getRepoProjectSectionId(parent, groups)).toBe(root.id)
  expect(getRepoProjectSectionId(child, groups)).toBe(root.id)
  expect(getProjectRepositoryLabel(parent, root)).toBe('embedded')
  expect(getProjectRepositoryLabel(child, root)).toBe('embedded/module')
  expect(getGroupKeysForWorktree('repo', parentCopy, map, null, undefined, groups)).toEqual([
    'project-group:root',
    'repo:embedded-repo'
  ])
  const rows = buildRows(
    'repo',
    copies,
    map,
    null,
    new Set(),
    undefined,
    undefined,
    'manual',
    undefined,
    undefined,
    false,
    undefined,
    groups
  )
  expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
    'project-group:root',
    'repo:embedded-repo',
    'repo:module'
  ])
  const collapsed = buildRows(
    'repo',
    copies,
    map,
    null,
    new Set(['project-group:root']),
    undefined,
    undefined,
    'manual',
    undefined,
    undefined,
    false,
    undefined,
    groups
  )
  expect(collapsed.filter((row) => row.type === 'item')).toHaveLength(0)
})
it('preserves manual sections and their identity while folding only scanned containers', () => {
  const manual: ProjectGroup = {
    ...container,
    id: 'manual',
    createdFrom: 'manual',
    parentGroupId: container.id
  }
  expect(getSidebarProjectGroups([root, container, manual])).toEqual([
    root,
    { ...manual, parentGroupId: root.id }
  ])
  expect(manual.parentGroupId).toBe(container.id)
  const remote = { ...container, executionHostId: 'runtime:other' }
  expect(getSidebarProjectGroups([root, remote])).toEqual([root, remote])
  expect(getSidebarProjectGroups([container])).toEqual([container])
})
it('folds imported containers into an existing manually created project home', () => {
  const home: ProjectGroup = { ...root, createdFrom: 'manual' }
  const entry = {
    ...repo,
    displayName: 'module',
    path: '/workspace/embedded/module',
    projectGroupId: container.id
  }
  expect(getSidebarProjectGroups([home, container])).toEqual([home])
  expect(getRepoProjectSectionId(entry, [home, container])).toBe(home.id)
  expect(getProjectRepositoryLabel(entry, home)).toBe('embedded/module')
  expect(home.createdFrom).toBe('manual')
  expect(getProjectRepositoryLabel({ ...entry, displayName: 'Custom module' }, home)).toBe(
    'Custom module · embedded/module'
  )
})
it('never reparents into another host or a manually organized folder', () => {
  const entry = { ...repo, path: '/workspace/embedded', projectGroupId: root.id }
  expect(getRepoProjectSectionId(entry, [{ ...container, executionHostId: 'runtime:other' }])).toBe(
    root.id
  )
  expect(getRepoProjectSectionId(entry, [{ ...container, createdFrom: 'manual' }])).toBe(root.id)
  expect(
    getRepoProjectSectionId({ ...entry, path: '/workspace/embedded-other' }, [container])
  ).toBe(root.id)
})
