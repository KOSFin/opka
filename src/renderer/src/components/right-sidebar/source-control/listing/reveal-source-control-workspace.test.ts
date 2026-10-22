import { beforeEach, expect, it, vi } from 'vitest'
import { revealSourceControlWorkspace } from './reveal-source-control-workspace'

const mocks = vi.hoisted(() => ({
  state: { activeWorktreeId: 'project', activeWorkspaceExecutionHostId: 'local' },
  activate: vi.fn().mockReturnValue({ primaryTabId: null }),
  connection: vi.fn().mockReturnValue(null)
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.activate }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: mocks.connection }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.activeWorktreeId = 'project'
  mocks.state.activeWorkspaceExecutionHostId = 'local'
  mocks.connection.mockReturnValue(null)
  mocks.activate.mockReturnValue({ primaryTabId: null })
})

it('opens a repository editor without seeding a terminal', () => {
  expect(revealSourceControlWorkspace('repo-main', { kind: 'local' })).toBe(true)
  expect(mocks.activate).toHaveBeenCalledWith('repo-main', {
    executionHostId: 'local',
    providesInitialSurface: true
  })
})
it('routes a remote file to its owning runtime rather than the selected host', () => {
  expect(
    revealSourceControlWorkspace('repo-main', { kind: 'environment', environmentId: 'remote' })
  ).toBe(true)
  expect(mocks.activate).toHaveBeenCalledWith('repo-main', {
    executionHostId: 'runtime:remote',
    providesInitialSurface: true
  })
})
it('does not reactivate the current copy and refuses an absent owner', () => {
  mocks.state.activeWorktreeId = 'repo-main'
  expect(revealSourceControlWorkspace('repo-main', { kind: 'local' })).toBe(true)
  expect(revealSourceControlWorkspace('repo-main', null)).toBe(false)
  expect(mocks.activate).not.toHaveBeenCalled()
})
it('preserves direct SSH ownership and refuses a failed activation', () => {
  mocks.connection.mockReturnValue('ssh-target')
  mocks.activate.mockReturnValue(false)
  expect(revealSourceControlWorkspace('repo-main', { kind: 'local' })).toBe(false)
  expect(mocks.activate).toHaveBeenCalledWith('repo-main', {
    executionHostId: 'ssh:ssh-target',
    providesInitialSurface: true
  })
})
