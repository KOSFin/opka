import { describe, expect, it } from 'vitest'
import { hostRepoCatalogSchema } from '../host-screen/host-screen-reply-schema'
import { desktopSectionRepo } from '../host-screen/use-host-repo-metadata'
import { buildProjectSectionCatalog } from './project-section-catalog'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { folderWorkspaceRepoId } from '../../../src/shared/folder-workspace-worktree'
import { groupProjectWorkspaceSections } from './project-group-workspace-sections'
import type { Section, SectionRepo, Worktree } from './workspace-list-types'

function group(host = 'local'): ProjectGroup {
  return {
    id: 'g',
    name: 'App',
    parentPath: '/app',
    parentGroupId: null,
    executionHostId: host,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}
function repo(id: string, grouped = true, host: ExecutionHostId = 'local'): SectionRepo {
  return {
    id,
    displayName: id,
    path: `/app/${id}`,
    executionHostId: host,
    projectGroupId: grouped ? 'g' : null
  }
}
function row(repoId: string): Worktree {
  return {
    worktreeId: repoId,
    repoId,
    repo: repoId,
    branch: 'main',
    displayName: 'Main',
    path: `/app/${repoId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}
function section(r: SectionRepo): Section {
  return { key: r.id, title: r.displayName, repo: r, data: [row(r.id)] }
}

describe('project group workspace sections', () => {
  it('keeps the group icon separate from its repository icon and host twin', () => {
    const localRepo = { ...repo('web'), repoIcon: { type: 'emoji', emoji: '🌊' } }
    const localGroup = {
      ...group(),
      groupIcon: { type: 'lucide' as const, name: 'Rocket' }
    }
    const remoteGroup = { ...group('ssh:remote'), groupIcon: null }
    const sections = groupProjectWorkspaceSections(
      [section(localRepo)],
      [localRepo],
      [remoteGroup, localGroup],
      new Set()
    )
    expect(sections[0]?.groupIcon).toEqual(localGroup.groupIcon)
    expect(sections[0]).toMatchObject({
      projectGroupId: localGroup.id,
      projectGroupHostId: 'local'
    })
    expect(sections[0]?.repo).toBeUndefined()
    expect(sections[1]?.repo?.repoIcon).toEqual(localRepo.repoIcon)
  })
  it('places project sessions above nested repos without duplicating a project folder header', () => {
    const app = repo('web')
    const folder = repo(folderWorkspaceRepoId('g'), false)
    const result = groupProjectWorkspaceSections(
      [section(app), section(folder)],
      [app],
      [group()],
      new Set()
    )
    expect(result.map((s) => s.title)).toEqual(['App', 'web'])
    expect(result[0]?.data[0]?.repoId).toBe(folder.id)
    expect(result[1]?.headerDepth).toBe(1)
    expect(result[0]?.count).toBe(2)
  })
  it('collapses the whole project independently of a repository', () => {
    const r = repo('web')
    const input = [section(r)]
    expect(
      groupProjectWorkspaceSections(input, [r], [group()], new Set(['project-group:local:g']))
    ).toHaveLength(1)
    const expanded = groupProjectWorkspaceSections(input, [r], [group()], new Set(['web']))
    expect(expanded[0]?.count).toBe(1)
    expect(expanded[1]?.data).toEqual([])
  })
  it('leaves standalone repos and older hosts truthful', () => {
    const r = repo('other', false)
    const input = [section(r)]
    expect(
      groupProjectWorkspaceSections(input, [r], [group()], new Set()).map((s) => s.title)
    ).toEqual(['other'])
    expect(groupProjectWorkspaceSections(input, [r], [], new Set(['other']))[0]?.data).toEqual([])
  })
  it('groups a cold headless repo reply through the fallback catalog with host isolation', () => {
    const incoming = hostRepoCatalogSchema.parse({
      repos: [
        {
          id: 'client',
          displayName: 'Client',
          path: '/app/client',
          projectGroupId: 'g',
          projectGroupOrder: 0
        },
        {
          id: 'service',
          displayName: 'Service',
          path: '/app/service',
          projectGroupId: 'g',
          projectGroupOrder: 1
        },
        {
          id: 'foreign',
          displayName: 'Foreign',
          path: '/foreign',
          projectGroupId: 'g',
          executionHostId: 'runtime:other'
        }
      ]
    })
    const catalog = buildProjectSectionCatalog(null, incoming.map(desktopSectionRepo), null, null)
    const folder = repo(folderWorkspaceRepoId('g'), false)
    const input = [...catalog.repos.map(section), section(folder)]
    const result = groupProjectWorkspaceSections(input, catalog.repos, [group()], new Set())
    expect(result.map((entry) => [entry.title, entry.headerDepth ?? 0])).toEqual([
      ['App', 0],
      ['Client', 1],
      ['Service', 1],
      ['Foreign', 0]
    ])
    expect(result[0]?.count).toBe(3)
    expect(result[0]?.data[0]?.repoId).toBe(folder.id)
    expect(catalog.repos.map((entry) => entry.projectGroupOrder)).toEqual([0, 1, undefined])
    const collapsed = groupProjectWorkspaceSections(
      input,
      catalog.repos,
      [group()],
      new Set(['project-group:local:g'])
    )
    expect(collapsed.map((entry) => entry.title)).toEqual(['App', 'Foreign'])
    expect(collapsed[0]?.data).toEqual([])
  })

  it('keeps malformed optional group metadata as standalone repos on a cold headless host', () => {
    const incoming = hostRepoCatalogSchema.parse({
      repos: [
        { id: 'bad', displayName: 'Bad', projectGroupId: 42, projectGroupOrder: 'first' },
        { id: 'old', displayName: 'Old' },
        { id: 'clear', displayName: 'Clear', projectGroupId: null, projectGroupOrder: Number.NaN }
      ]
    })
    const catalog = buildProjectSectionCatalog(null, incoming.map(desktopSectionRepo), null, null)
    const result = groupProjectWorkspaceSections(
      catalog.repos.map(section),
      catalog.repos,
      [group()],
      new Set()
    )
    expect(result.map((entry) => entry.title)).toEqual(['Bad', 'Old', 'Clear'])
    expect(catalog.repos.map((entry) => entry.projectGroupId)).toEqual([undefined, undefined, null])
    expect(catalog.repos.every((entry) => entry.projectGroupOrder === undefined)).toBe(true)
  })
  it('does not adopt an identical group id belonging to another host', () => {
    const r = repo('web', true, 'runtime:other')
    expect(
      groupProjectWorkspaceSections([section(r)], [r], [group()], new Set()).map((s) => s.title)
    ).toEqual(['web'])
  })
})
