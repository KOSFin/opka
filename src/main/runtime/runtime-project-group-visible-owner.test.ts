import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { orcadMigrationCutoverFixture } from '../ssh/orcad-migration-cutover-fixture'
import { writeOrcadMigrationSourceCutover } from '../ssh/orcad-migration-cutover-journal'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import type { RuntimeStore } from './runtime-store-contract'

const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => profile.dir })
}))
import { RuntimeProjectGroupController } from './runtime-project-group-controller'

const unused = (): never => {
  throw new Error('unused')
}
const group = (id: string, connectionId: string | null = null): ProjectGroup => ({
  id,
  name: id,
  parentPath: '/project',
  connectionId,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
})
const repo = (id: string, path: string, connectionId?: string): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: '#000',
  addedAt: 1,
  ...(connectionId ? { connectionId } : {})
})
const sshTarget: SshTarget = {
  id: 'ssh-box',
  label: 'Box',
  host: 'box.example.com',
  port: 22,
  username: 'synthetic',
  generation: 2,
  orcadFence: { environmentId: 'env-1' }
}

function fixture(groups: ProjectGroup[], repos: Repo[], targets: SshTarget[] = []) {
  const updateProjectGroup = vi.fn<NonNullable<RuntimeStore['updateProjectGroup']>>(
    (id, updates) => {
      const row = groups.find((item) => item.id === id)
      return row ? Object.assign(row, updates) : null
    }
  )
  const moveProjectToGroup = vi.fn<NonNullable<RuntimeStore['moveProjectToGroup']>>(
    (target, groupId) => {
      const row = repos.find(
        (item) => item.id === target.id && item.connectionId === target.connectionId
      )
      return row ? Object.assign(row, { projectGroupId: groupId }) : null
    }
  )
  const notifyReposChanged = vi.fn()
  const store: RuntimeStore = {
    getProjectGroups: () => [...groups],
    getRepos: () => [...repos],
    getSshTargets: () => targets,
    updateProjectGroup,
    moveProjectToGroup,
    getRepo: (id) => repos.find((item) => item.id === id),
    addRepo: unused,
    updateRepo: unused,
    getAllWorktreeMeta: unused,
    getWorktreeMeta: unused,
    setWorktreeMeta: unused,
    removeWorktreeMeta: unused,
    getGitHubCache: unused,
    getSettings: unused
  }
  let resolveRepo: () => Promise<Repo> = async () => repos[0]!
  const controller = new RuntimeProjectGroupController({
    getStore: () => store,
    resolveRepo: () => resolveRepo(),
    notifyReposChanged,
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: async () => undefined,
    cleanupRemovedFolderWorkspaceState: () => undefined
  })
  return {
    controller,
    updateProjectGroup,
    moveProjectToGroup,
    notifyReposChanged,
    setResolver: (next: () => Promise<Repo>) => {
      resolveRepo = next
    }
  }
}

describe('project group write uses the current visible owner', () => {
  beforeEach(() => {
    profile.dir = mkdtempSync(join(tmpdir(), 'project-group-visible-owner-'))
  })
  afterEach(() => {
    resetWslMoveFenceForTests()
    rmSync(profile.dir, { recursive: true, force: true })
  })

  it('keeps retained SSH group and repo unchanged for rename, move and ungroup', async () => {
    writeOrcadMigrationSourceCutover(profile.dir, {
      ...orcadMigrationCutoverFixture('move-1', sshTarget.id),
      phase: 'destination-committed'
    })
    const groups = [group('source', sshTarget.id), group('local')]
    const repos = [repo('remote', '/srv/remote', sshTarget.id), repo('local', '/project')]
    const state = fixture(groups, repos, [sshTarget])
    await expect(state.controller.updateGroup('source', { name: 'Changed' })).rejects.toThrow(
      'project_group_not_visible'
    )
    await expect(state.controller.moveProject('remote', 'local')).rejects.toThrow(
      'repo_not_visible'
    )
    await expect(state.controller.moveProject('remote', null)).rejects.toThrow('repo_not_visible')
    state.setResolver(async () => repos[1]!)
    await expect(state.controller.moveProject('local', 'source')).rejects.toThrow(
      'target_group_not_visible'
    )
    expect(groups.map((item) => item.name)).toEqual(['source', 'local'])
    expect(repos.map((item) => item.projectGroupId)).toEqual([undefined, undefined])
    expect(state.updateProjectGroup).not.toHaveBeenCalled()
    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(state.notifyReposChanged).not.toHaveBeenCalled()
  })

  it('keeps a WSL moved source repo unchanged for move and ungroup', async () => {
    loadWslMoveFence(profile.dir)
    seedWslMoveCutover(
      profile.dir,
      wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: ['moved'] })
    )
    const groups = [group('local')]
    const repos = [repo('moved', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project')]
    const state = fixture(groups, repos)
    await expect(state.controller.moveProject('moved', 'local')).rejects.toThrow('repo_not_visible')
    await expect(state.controller.moveProject('moved', null)).rejects.toThrow('repo_not_visible')
    expect(repos[0]?.projectGroupId).toBeUndefined()
    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(state.notifyReposChanged).not.toHaveBeenCalled()
  })

  it('refuses a deleted or replaced destination after asynchronous repo resolution', async () => {
    const groups = [group('destination')]
    const repos = [repo('local', '/project')]
    const state = fixture(groups, repos)
    let finish!: (value: Repo) => void
    state.setResolver(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = state.controller.moveProject('local', 'destination')
    groups.splice(0)
    finish(repos[0]!)
    await expect(pending).rejects.toThrow('target_group_not_visible')
    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(state.notifyReposChanged).not.toHaveBeenCalled()
  })

  it('refuses a changed source after asynchronous repo resolution', async () => {
    const groups = [group('destination')]
    const original = repo('local', '/project')
    const repos = [original]
    const state = fixture(groups, repos)
    let finish!: (value: Repo) => void
    state.setResolver(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = state.controller.moveProject('local', null)
    repos[0] = { ...original, path: '/replaced' }
    finish(original)
    await expect(pending).rejects.toThrow('repo_not_visible')
    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
  })

  it('refuses a source or destination whose SSH ownership changes during resolution', async () => {
    const groups = [group('remote', sshTarget.id)]
    const repos = [repo('remote', '/srv/remote', sshTarget.id), repo('local', '/project')]
    const state = fixture(groups, repos, [sshTarget])
    let finish!: (value: Repo) => void
    state.setResolver(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pendingSource = state.controller.moveProject('remote', null)
    writeOrcadMigrationSourceCutover(profile.dir, {
      ...orcadMigrationCutoverFixture('move-2', sshTarget.id),
      phase: 'destination-committed'
    })
    finish(repos[0]!)
    await expect(pendingSource).rejects.toThrow('repo_not_visible')
    const pendingDestination = state.controller.moveProject('local', 'remote')
    finish(repos[1]!)
    await expect(pendingDestination).rejects.toThrow('target_group_not_visible')
    expect(state.moveProjectToGroup).not.toHaveBeenCalled()
    expect(state.notifyReposChanged).not.toHaveBeenCalled()
  })

  it('refuses duplicate group ids without choosing a host', async () => {
    const state = fixture([group('same'), group('same', sshTarget.id)], [repo('local', '/project')])
    await expect(state.controller.updateGroup('same', { name: 'Changed' })).rejects.toThrow(
      'project_group_not_visible'
    )
    expect(state.updateProjectGroup).not.toHaveBeenCalled()
  })

  it('updates a visible local group and moves its own repo, including ungroup', async () => {
    const groups = [group('local')]
    const repos = [repo('local', '/project')]
    const state = fixture(groups, repos)
    await state.controller.updateGroup('local', { name: 'Renamed' })
    await state.controller.moveProject('local', 'local')
    await state.controller.moveProject('local', null)
    expect(groups[0]?.name).toBe('Renamed')
    expect(repos[0]?.projectGroupId).toBeNull()
    expect(state.updateProjectGroup).toHaveBeenCalledTimes(1)
    expect(state.moveProjectToGroup).toHaveBeenCalledTimes(2)
    expect(state.notifyReposChanged).toHaveBeenCalledTimes(3)
  })

  it('moves only the selected host row when repo ids match', async () => {
    const groups = [group('remote', sshTarget.id)]
    const repos = [repo('same', '/project'), repo('same', '/srv/project', sshTarget.id)]
    const state = fixture(groups, repos)
    state.setResolver(async () => repos[1]!)
    await state.controller.moveProject('same', 'remote', undefined, sshTarget.id)
    expect(repos.map((item) => item.projectGroupId)).toEqual([undefined, 'remote'])
    expect(state.moveProjectToGroup).toHaveBeenCalledTimes(1)
  })
})
