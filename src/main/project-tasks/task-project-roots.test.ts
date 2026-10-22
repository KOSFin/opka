import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initializeTaskFiles } from './task-workspace-init'
import {
  readTaskProjectCatalog,
  resolveRegisteredTaskRoot,
  taskRootContains,
  type TaskProjectRootsHost
} from './task-project-roots'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-task-roots-')))
  temporary.push(root)
  const child = join(root, 'apps/web')
  await mkdir(child, { recursive: true })
  const folders: ReturnType<TaskProjectRootsHost['listVisibleFolderWorkspaces']> = [
    {
      id: 'folder',
      name: 'Project home',
      projectGroupId: 'group',
      folderPath: root,
      isArchived: false
    }
  ]
  const repos: ReturnType<TaskProjectRootsHost['listVisibleRepos']> = [
    { id: 'web', path: child, displayName: 'web' }
  ]
  const host: TaskProjectRootsHost = {
    listVisibleFolderWorkspaces: () => folders,
    listVisibleRepos: () => repos,
    listVisibleProjectGroups: () => [{ id: 'group', name: 'Overall project' }]
  }
  return { root, child, folders, repos, host }
}
it('uses the registered overall project for a child checkout and lists it only once', async () => {
  const { root, child, folders, host } = await fixture()
  await initializeTaskFiles(root)
  folders.push({ ...folders[0], id: 'duplicate' })
  expect(await resolveRegisteredTaskRoot(host, child)).toBe(root)
  const catalog = await readTaskProjectCatalog(host)
  expect(catalog.projects).toHaveLength(1)
  expect(catalog.projects[0]).toMatchObject({
    name: 'Overall project',
    root,
    state: 'configured',
    selector: 'folder:folder'
  })
})
it('does not create child config or walk unregistered ancestors', async () => {
  const { root, child, folders, host } = await fixture()
  await initializeTaskFiles(root)
  folders.length = 0
  expect(await resolveRegisteredTaskRoot(host, child)).toBe(child)
  expect((await readTaskProjectCatalog(host)).projects[0].state).toBe('unconfigured')
})
it('retains deliberately configured child projects and their own identities', async () => {
  const { root, child, host } = await fixture()
  const parent = await initializeTaskFiles(root),
    nested = await initializeTaskFiles(child)
  expect(parent.id).not.toBe(nested.id)
  expect(await resolveRegisteredTaskRoot(host, child)).toBe(child)
  expect((await readTaskProjectCatalog(host)).projects.map((entry) => entry.projectId)).toEqual([
    parent.id,
    nested.id
  ])
})
it('excludes other execution hosts before any filesystem probe', async () => {
  const { root, folders, repos, host } = await fixture()
  folders[0].connectionId = 'ssh-other'
  repos[0].executionHostId = 'runtime:other'
  expect((await readTaskProjectCatalog(host)).projects).toEqual([])
  expect(await resolveRegisteredTaskRoot(host, root)).toBe(root)
})

it('does not treat a folder inheriting a remote group owner as local', async () => {
  const { host, repos } = await fixture()
  repos.length = 0
  host.listVisibleProjectGroups = () => [
    { id: 'group', name: 'Remote project', executionHostId: 'runtime:other' }
  ]
  expect((await readTaskProjectCatalog(host)).projects).toEqual([])
})
it('reports a symlinked config as unavailable rather than empty and never escapes to its parent', async () => {
  const { root, child, host } = await fixture()
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'orca-task-outside-')))
  temporary.push(elsewhere)
  await initializeTaskFiles(elsewhere)
  await symlink(
    join(elsewhere, '.orca'),
    join(root, '.orca'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  expect((await readTaskProjectCatalog(host)).projects[0].state).toBe('unavailable')
  await expect(resolveRegisteredTaskRoot(host, child)).rejects.toThrow(
    /configuration could not be read/
  )
})
it('treats a missing config as setup state and respects path boundaries', async () => {
  const { host } = await fixture()
  expect((await readTaskProjectCatalog(host)).projects).toHaveLength(1)
  expect((await readTaskProjectCatalog(host)).projects[0].state).toBe('unconfigured')
  expect(taskRootContains(join(tmpdir(), 'project'), join(tmpdir(), 'project-other'))).toBe(false)
})

it('resolves registered root aliases without duplicating their task project', async () => {
  const { root, child, folders, host } = await fixture()
  await initializeTaskFiles(root)
  const aliasParent = await mkdtemp(join(tmpdir(), 'orca-task-alias-'))
  temporary.push(aliasParent)
  const alias = join(aliasParent, 'project')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  folders[0].folderPath = alias
  expect(await resolveRegisteredTaskRoot(host, child)).toBe(root)
  folders.push({ ...folders[0], id: 'canonical', folderPath: root })
  expect((await readTaskProjectCatalog(host)).projects).toHaveLength(1)
})
