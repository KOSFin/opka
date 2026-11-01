import { describe, expect, it } from 'vitest'
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
  it('does not adopt an identical group id belonging to another host', () => {
    const r = repo('web', true, 'runtime:other')
    expect(
      groupProjectWorkspaceSections([section(r)], [r], [group()], new Set()).map((s) => s.title)
    ).toEqual(['web'])
  })
})
