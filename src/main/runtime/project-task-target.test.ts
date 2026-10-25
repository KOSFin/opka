import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskProjectRootsHost } from '../project-tasks/task-project-roots'
import type { ResolvedRuntimeFileTarget } from './files/file-target'
import { resolveProjectTaskTarget } from './project-task-target'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opka-task-target-')))
  temporary.push(root)
  const child = join(root, 'web')
  await mkdir(child)
  const folders: ReturnType<TaskProjectRootsHost['listVisibleFolderWorkspaces']> = [
    {
      id: 'project',
      name: 'Synthetic',
      folderPath: root,
      projectGroupId: 'group',
      isArchived: false
    }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this resolver test only reads path and executionHostId from synthetic targets.
  const target = { executionHostId: 'local', worktree: { path: root } } as ResolvedRuntimeFileTarget
  const resolveRuntimeFileTarget = vi.fn(async (selector: string) => {
    if (selector === 'folder:project') {
      return target
    }
    throw new Error('selector_not_found')
  })
  const host = {
    listVisibleFolderWorkspaces: () => folders,
    listVisibleRepos: () => [],
    listVisibleProjectGroups: () => [],
    resolveRuntimeFileTarget
  }
  return { root, child, folders, target, host }
}

it('resolves current folder and nested cwd through their registered owning workspace', async () => {
  const { root, child, target, host } = await fixture()
  expect(await resolveProjectTaskTarget(host, `path:${root}`, 'local')).toEqual({
    target,
    selectedPath: root
  })
  expect(await resolveProjectTaskTarget(host, `path:${child}`)).toEqual({
    target,
    selectedPath: child
  })
  expect(host.resolveRuntimeFileTarget).toHaveBeenLastCalledWith('folder:project')
})

it('preserves successful Git and remote target resolution without scanning registrations', async () => {
  const { host, target } = await fixture()
  host.resolveRuntimeFileTarget.mockResolvedValue(target)
  host.listVisibleFolderWorkspaces = () => {
    throw new Error('Must not scan')
  }
  expect((await resolveProjectTaskTarget(host, 'id:git')).target).toBe(target)
})

it('uses the innermost registered folder and preserves its nested working directory', async () => {
  const { host, root, child, folders, target } = await fixture()
  const leaf = join(child, 'source')
  await mkdir(leaf)
  folders.push({ ...folders[0], id: 'nested', folderPath: child })
  host.resolveRuntimeFileTarget.mockImplementation(async (selector) => {
    if (selector === 'folder:nested') {
      return { ...target, worktree: { ...target.worktree, path: child } }
    }
    if (selector === 'folder:project') {
      return target
    }
    throw new Error('selector_not_found')
  })
  const resolved = await resolveProjectTaskTarget(host, `path:${leaf}`)
  expect(resolved.selectedPath).toBe(leaf)
  expect(resolved.target.worktree.path).toBe(child)
  expect(resolved.target.worktree.path).not.toBe(root)
})

it('uses an already registered Git root for a nested cwd without inventing a folder workspace', async () => {
  const { root, child, target, host, folders } = await fixture()
  folders.length = 0
  const repoHost = {
    ...host,
    listVisibleRepos: () => [{ id: 'git', path: root, displayName: 'Git' }]
  }
  host.resolveRuntimeFileTarget.mockImplementation(async (selector) => {
    if (selector === `path:${root}`) {
      return target
    }
    throw new Error('selector_not_found')
  })
  expect(await resolveProjectTaskTarget(repoHost, `path:${child}`)).toEqual({
    target,
    selectedPath: child
  })
})

it.each(['selector_ambiguous', 'connection_unavailable', 'permission_denied'])(
  'does not reinterpret %s as a local folder',
  async (message) => {
    const { host, root } = await fixture()
    host.resolveRuntimeFileTarget.mockRejectedValue(new Error(message))
    await expect(resolveProjectTaskTarget(host, `path:${root}`)).rejects.toThrow(message)
    expect(host.resolveRuntimeFileTarget).toHaveBeenCalledTimes(1)
  }
)

it('never falls back for explicit nonlocal ownership, archived or SSH registrations', async () => {
  const { host, root, folders } = await fixture()
  await expect(resolveProjectTaskTarget(host, `path:${root}`, 'ssh:other')).rejects.toThrow(
    'selector_not_found'
  )
  expect(host.resolveRuntimeFileTarget).toHaveBeenCalledTimes(1)
  folders[0].connectionId = 'other'
  await expect(resolveProjectTaskTarget(host, `path:${root}`)).rejects.toThrow('selector_not_found')
  delete folders[0].connectionId
  folders[0].isArchived = true
  await expect(resolveProjectTaskTarget(host, `path:${root}`)).rejects.toThrow('selector_not_found')
})

it('rejects unregistered paths and symlink escapes instead of walking arbitrary ancestors', async () => {
  const { host, child, folders, root } = await fixture()
  folders[0].folderPath = child
  await expect(resolveProjectTaskTarget(host, `path:${root}`)).rejects.toThrow('selector_not_found')
  await symlink(root, join(child, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(resolveProjectTaskTarget(host, `path:${join(child, 'outside')}`)).rejects.toThrow(
    'selector_not_found'
  )
})

it('rejects a registration whose execution host changed during resolution', async () => {
  const { host, target, root } = await fixture()
  host.resolveRuntimeFileTarget.mockImplementation(async (selector) => {
    if (selector.startsWith('folder:')) {
      return { ...target, executionHostId: 'ssh:changed' }
    }
    throw new Error('selector_not_found')
  })
  await expect(resolveProjectTaskTarget(host, `path:${root}`)).rejects.toThrow()
})

it('rejects a registration whose path changed during resolution', async () => {
  const { host, target, root, child } = await fixture()
  host.resolveRuntimeFileTarget.mockImplementation(async (selector) => {
    if (selector.startsWith('folder:')) {
      return { ...target, worktree: { ...target.worktree, path: child } }
    }
    throw new Error('selector_not_found')
  })
  await expect(resolveProjectTaskTarget(host, `path:${root}`)).rejects.toThrow(
    'registration changed'
  )
})
