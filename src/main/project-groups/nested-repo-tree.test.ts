import { describe, expect, it } from 'vitest'
import { createProjectGroup as createGroup } from '../../shared/project-groups'
import { createNestedProjectGroupResolver } from './nested-repo-import'

function createProjectGroup(input: Omit<Parameters<typeof createGroup>[0], 'tabOrder'>) {
  return createGroup({ ...input, tabOrder: 0 })
}

describe('folder-backed repository trees', () => {
  it('reuses the exact folder workspace root without creating a second manual/scan group', () => {
    const root = createProjectGroup({
      name: 'My project',
      parentPath: '/work',
      createdFrom: 'manual'
    })
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/work',
      groupName: 'Other',
      mode: 'group',
      repoPaths: ['/work/apps/web'],
      existingGroups: [root],
      folderWorkspaces: [{ projectGroupId: root.id, folderPath: '/work' }],
      createGroup: (input) => createProjectGroup(input)
    })
    resolver.getGroupForRepo('/work/apps/web')
    expect(resolver.getRootGroup()).toBe(root)
    expect(resolver.getCreatedGroups().map((group) => group.name)).toEqual(['apps'])
  })
  it('keeps every folder level even when it contains only one repository', () => {
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/work',
      groupName: 'Work',
      mode: 'group',
      repoPaths: ['/work/apps/client', '/work/services/payments/api'],
      createGroup: (input) => createProjectGroup(input)
    })
    const client = resolver.getGroupForRepo('/work/apps/client')
    const api = resolver.getGroupForRepo('/work/services/payments/api')
    const groups = resolver.getCreatedGroups()
    expect(client?.name).toBe('apps')
    expect(api?.name).toBe('payments')
    expect(groups.map((group) => group.name)).toEqual(['Work', 'apps', 'services', 'payments'])
    expect(api?.parentGroupId).toBe(groups.find((group) => group.name === 'services')?.id)
  })

  it('reuses host-owned folder groups without resetting user customizations', () => {
    const root = createProjectGroup({
      name: 'Renamed work',
      parentPath: '/work',
      createdFrom: 'folder-scan'
    })
    const apps = createProjectGroup({
      name: 'My apps',
      parentPath: '/work/apps',
      parentGroupId: root.id,
      createdFrom: 'folder-scan'
    })
    apps.isCollapsed = true
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/work',
      groupName: 'Work',
      mode: 'group',
      repoPaths: ['/work/apps/client'],
      existingGroups: [root, apps],
      createGroup: (input) => createProjectGroup(input)
    })
    expect(resolver.getGroupForRepo('/work/apps/client')).toBe(apps)
    expect(resolver.getRootGroup()).toBe(root)
    expect(resolver.getCreatedGroups()).toEqual([])
    expect(apps.isCollapsed).toBe(true)
    expect(apps.name).toBe('My apps')
  })

  it('never reuses a manual group or a group belonging to another SSH host', () => {
    const manual = createProjectGroup({
      name: 'Manual',
      parentPath: '/work',
      createdFrom: 'manual'
    })
    const remote = createProjectGroup({
      name: 'Remote',
      parentPath: '/work',
      connectionId: 'other',
      createdFrom: 'folder-scan'
    })
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/work',
      groupName: 'Work',
      mode: 'group',
      connectionId: 'audit',
      repoPaths: ['/work/apps/client'],
      existingGroups: [manual, remote],
      createGroup: (input) => createProjectGroup(input)
    })
    resolver.getGroupForRepo('/work/apps/client')
    expect(resolver.getRootGroup()?.id).not.toBe(manual.id)
    expect(resolver.getRootGroup()?.id).not.toBe(remote.id)
    expect(resolver.getCreatedGroups().map((group) => group.connectionId)).toEqual([
      'audit',
      'audit'
    ])
  })

  it('retains the UNC share root and creates each intermediate directory', () => {
    const resolver = createNestedProjectGroupResolver({
      parentPath: '\\\\server\\share',
      groupName: 'Share',
      mode: 'group',
      repoPaths: ['\\\\server\\share\\services\\payments\\api'],
      createGroup: (input) => createProjectGroup(input)
    })
    expect(resolver.getGroupForRepo('\\\\server\\share\\services\\payments\\api')?.name).toBe(
      'payments'
    )
    expect(resolver.getCreatedGroups().map((group) => group.parentPath)).toEqual([
      '//server/share',
      '//server/share/services',
      '//server/share/services/payments'
    ])
  })

  it('reuses Windows folder identities across drive-case and separator changes', () => {
    const root = createProjectGroup({
      name: 'Work',
      parentPath: 'C:\\work',
      createdFrom: 'folder-scan'
    })
    const services = createProjectGroup({
      name: 'Services',
      parentPath: 'C:\\work\\services',
      parentGroupId: root.id,
      createdFrom: 'folder-scan'
    })
    const resolver = createNestedProjectGroupResolver({
      parentPath: 'c:/work',
      groupName: 'Other name',
      mode: 'group',
      repoPaths: ['c:/work/services/api'],
      existingGroups: [root, services],
      createGroup: (input) => createProjectGroup(input)
    })
    expect(resolver.getGroupForRepo('c:/work/services/api')).toBe(services)
    expect(resolver.getCreatedGroups()).toEqual([])
  })
})
