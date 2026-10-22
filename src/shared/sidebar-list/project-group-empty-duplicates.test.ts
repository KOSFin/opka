import { expect, it } from 'vitest'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import { omitEmptyDuplicateProjectGroups } from './project-group-empty-duplicates'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: 'apps',
    parentPath: '/project/apps',
    parentGroupId: 'root',
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const repo: Repo = {
  id: 'web',
  path: '/project/apps/web',
  displayName: 'web',
  badgeColor: '',
  addedAt: 0,
  projectGroupId: 'populated'
}

it('hides only empty scan aliases without changing occupied identities', () => {
  const groups = [group('empty'), group('populated')]
  const visible = omitEmptyDuplicateProjectGroups(groups, [repo], [])
  expect(visible).toEqual([groups[1]])
  expect(visible[0]).toBe(groups[1])
  expect(groups).toHaveLength(2)
})

it('keeps manual groups, different paths, parents and execution hosts', () => {
  const groups = [
    group('populated'),
    group('manual', { createdFrom: 'manual' }),
    group('other-path', { parentPath: '/other/apps' }),
    group('other-parent', { parentGroupId: 'other' }),
    group('remote', { executionHostId: 'runtime:remote' })
  ]
  expect(omitEmptyDuplicateProjectGroups(groups, [repo], [])).toBe(groups)
})

it('keeps two occupied groups and groups containing occupied descendants', () => {
  const groups = [
    group('populated'),
    group('second'),
    group('child', { parentGroupId: 'second', parentPath: '/project/apps/nested' })
  ]
  expect(
    omitEmptyDuplicateProjectGroups(
      groups,
      [repo, { ...repo, id: 'nested', projectGroupId: 'child' }],
      []
    )
  ).toBe(groups)
})

it('keeps one deterministic alias when both are empty', () => {
  const groups = [group('first'), group('second')]
  expect(omitEmptyDuplicateProjectGroups(groups, [], [])).toEqual([groups[0]])
})

it('does not borrow occupancy from a same-id group on another host', () => {
  const groups = [
    group('first'),
    group('populated'),
    group('populated', { executionHostId: 'runtime:remote' })
  ]
  const visible = omitEmptyDuplicateProjectGroups(
    groups,
    [{ ...repo, executionHostId: 'runtime:remote' }],
    []
  )
  expect(visible).toEqual([groups[0], groups[2]])
})
