import { describe, expect, it } from 'vitest'
import {
  clearMissingProjectGroupMemberships,
  createProjectGroup,
  getEffectiveProjectGroupManualRank,
  getNextProjectGroupOrder,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName,
  normalizeProjectGroups
} from './project-groups'
import type { Repo } from './repo-types'
import { ProjectGroupSchema } from './project-section-catalog-schema'
import { ProjectGroupUpdate } from './rpc-contract/repo-params'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: overrides.id ?? 'repo-1',
    path: overrides.path ?? '/repo',
    displayName: overrides.displayName ?? 'repo',
    badgeColor: '#999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('project-groups', () => {
  it('creates a durable project group with normalized defaults', () => {
    const group = createProjectGroup({
      name: '  Platform  ',
      parentPath: '/srv/platform',
      createdFrom: 'folder-scan',
      tabOrder: 3,
      now: 100
    })

    expect(group).toMatchObject({
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 3,
      isCollapsed: false,
      color: null,
      createdAt: 100,
      updatedAt: 100
    })
  })

  it('trims empty group names to a fallback', () => {
    expect(normalizeProjectGroupName('   ', 'Existing')).toBe('Existing')
  })

  it('normalizes persisted groups and drops malformed entries', () => {
    const groups = normalizeProjectGroups([
      { id: 'b', name: 'B', tabOrder: 2 },
      {
        id: 'a',
        name: 'A',
        tabOrder: 1,
        parentGroupId: 'missing',
        createdFrom: 'folder-scan',
        isCollapsed: true
      },
      { id: 'a', name: 'duplicate' },
      { name: 'missing id' }
    ])

    expect(groups.map((group) => group.id)).toEqual(['a', 'b'])
    expect(groups[0]).toMatchObject({
      createdFrom: 'folder-scan',
      isCollapsed: true,
      parentGroupId: null
    })
  })

  it('preserves normalized execution ownership for persisted groups', () => {
    const groups = normalizeProjectGroups([
      { id: 'runtime', name: 'Runtime', tabOrder: 1, executionHostId: 'runtime:env-1' },
      { id: 'local', name: 'Local', tabOrder: 2, executionHostId: 'local' },
      { id: 'invalid', name: 'Invalid', tabOrder: 3, executionHostId: 'runtime:' }
    ])

    expect(groups.find((group) => group.id === 'runtime')?.executionHostId).toBe('runtime:env-1')
    expect(groups.find((group) => group.id === 'local')?.executionHostId).toBe('local')
    expect(groups.find((group) => group.id === 'invalid')?.executionHostId).toBeUndefined()
  })

  it('preserves an optional group icon without copying a repository icon or rewriting legacy rows', () => {
    const icon = { type: 'emoji' as const, emoji: '📁' }
    const created = createProjectGroup({
      name: 'Folder',
      createdFrom: 'manual',
      tabOrder: 1,
      groupIcon: icon
    })
    expect(created.groupIcon).toEqual(icon)
    const restored = normalizeProjectGroups([
      created,
      { ...created, id: 'reset', groupIcon: null },
      { ...created, id: 'legacy', groupIcon: undefined },
      { ...created, id: 'invalid', groupIcon: { type: 'emoji', emoji: 'x'.repeat(17) } }
    ])
    expect(restored.find((group) => group.id === created.id)?.groupIcon).toEqual(icon)
    expect(restored.find((group) => group.id === 'reset')?.groupIcon).toBeNull()
    expect(restored.find((group) => group.id === 'legacy')?.groupIcon).toBeUndefined()
    expect(restored.find((group) => group.id === 'invalid')?.groupIcon).toBeUndefined()
    expect(ProjectGroupSchema.parse(created).groupIcon).toEqual(icon)
    expect(ProjectGroupSchema.parse({ ...created, groupIcon: null }).groupIcon).toBeNull()
    expect(ProjectGroupSchema.parse({ ...created, groupIcon: undefined }).groupIcon).toBeUndefined()
    expect(
      ProjectGroupUpdate.parse({ groupId: created.id, updates: { groupIcon: null } }).updates
        .groupIcon
    ).toBeNull()
  })

  it('clears repo memberships whose group no longer exists', () => {
    const groups = [createProjectGroup({ name: 'Known', createdFrom: 'manual', tabOrder: 0 })]
    const repos = clearMissingProjectGroupMemberships(
      [
        repo({ id: 'known', projectGroupId: groups[0].id }),
        repo({ id: 'missing', projectGroupId: 'x' })
      ],
      groups
    )

    expect(repos.find((entry) => entry.id === 'known')?.projectGroupId).toBe(groups[0].id)
    expect(repos.find((entry) => entry.id === 'missing')?.projectGroupId).toBeNull()
  })

  it('falls back to global repo order when projectGroupOrder is unset', () => {
    const repoOrder = new Map([
      ['a', 0],
      ['b', 2]
    ])

    expect(
      getEffectiveProjectGroupManualRank(repo({ id: 'a', projectGroupOrder: 5 }), repoOrder)
    ).toBe(5)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'a' }), repoOrder)).toBe(0)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'b' }), repoOrder)).toBe(2000)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'c' }), repoOrder, 1)).toBe(1000)
  })

  it('computes the next order inside a group independently from ungrouped repos', () => {
    expect(
      getNextProjectGroupOrder(
        [
          repo({ id: 'a', projectGroupId: 'g', projectGroupOrder: 2 }),
          repo({ id: 'b', projectGroupId: null, projectGroupOrder: 9 })
        ],
        'g'
      )
    ).toBe(3)
  })

  it('collects descendant group ids for subtree deletion', () => {
    expect(
      [
        ...getProjectGroupSubtreeIds(
          [
            { id: 'root', parentGroupId: null },
            { id: 'child', parentGroupId: 'root' },
            { id: 'grandchild', parentGroupId: 'child' },
            { id: 'sibling', parentGroupId: null }
          ],
          'root'
        )
      ].sort()
    ).toEqual(['child', 'grandchild', 'root'])
  })

  it('collects wide descendant groups without overflowing argument limits', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      ...Array.from({ length: 130_000 }, (_, index) => ({
        id: `child-${index}`,
        parentGroupId: 'root'
      }))
    ]

    const subtreeIds = getProjectGroupSubtreeIds(groups, 'root')

    expect(subtreeIds.size).toBe(130_001)
    expect(subtreeIds.has('root')).toBe(true)
    expect(subtreeIds.has('child-129999')).toBe(true)
  })
})
