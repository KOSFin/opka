import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { setCachedRepos, forgetCachedRepos } from '../cache/repo-cache'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

const serverRepo: MobileWorkspaceRepo = {
  id: 'shared-server-repo',
  displayName: 'Server repo',
  path: '/server/repo',
  executionHostId: 'runtime:shared-server'
}
vi.mock('../worktree/use-server-repos', () => ({
  useServerRepos: () => new Map([['runtime:shared-server', [serverRepo]]])
}))
vi.mock('../worktree/use-last-visited-worktree-repo', () => ({
  useLastVisitedWorktreeRepoId: () => ({ loaded: false, repoId: null })
}))
import { useNewWorkspaceRepositories } from './use-new-workspace-repositories'

let renderer: ReactTestRenderer | undefined
let observed: ReturnType<typeof useNewWorkspaceRepositories> | undefined
const renderedSelections: (MobileWorkspaceRepo | null)[] = []
function Probe({ hostId }: { hostId: string }) {
  observed = useNewWorkspaceRepositories({ client: null, hostId, visible: false })
  renderedSelections.push(observed.selectedRepo)
  return null
}
function current() {
  if (!observed) {
    throw new Error('Probe has not rendered')
  }
  return observed
}
afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
  }
  renderer = undefined
  observed = undefined
  renderedSelections.length = 0
  forgetCachedRepos('picker-owner-a')
})

it('does not expose the prior owner selection in a render before effects', () => {
  act(() => {
    renderer = create(createElement(Probe, { hostId: 'picker-owner-a' }))
  })
  act(() => current().setSelectedRepo(serverRepo))
  expect(current().selectedRepo).toEqual(serverRepo)
  renderedSelections.length = 0
  act(() => renderer?.update(createElement(Probe, { hostId: 'picker-owner-b' })))
  expect(renderedSelections.length).toBeGreaterThan(0)
  expect(renderedSelections.every((repo) => repo === null)).toBe(true)
})

it('checks cached picker rows while salvaging unsupported optional metadata', () => {
  setCachedRepos('picker-owner-a', [
    { id: 'valid', displayName: 'Retained', path: '/repo', kind: 'future-kind' },
    { id: 'missing-required-path', displayName: 'Invalid' }
  ])
  act(() => {
    renderer = create(createElement(Probe, { hostId: 'picker-owner-a' }))
  })
  expect(current().repos.find((repo) => repo.id === 'valid')).toMatchObject({ path: '/repo' })
  expect(current().repos.some((repo) => repo.id === 'missing-required-path')).toBe(false)
})
