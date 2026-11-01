import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
vi.mock('./mobile-tasks-dependencies', async () => ({
  ...(await import('react')),
  colors: (await import('../theme/mobile-theme')).colors,
  isHostedTaskRepo: (await import('./hosted-repo-selection')).isHostedTaskRepo
}))
vi.mock('./mobile-tasks-legacy-foundation', async () => ({
  ...(await import('./mobile-tasks-item-mapping')),
  ...(await import('./mobile-tasks-repository-presentation')),
  GITHUB_REPO_CONCURRENCY: 3,
  GITLAB_PER_PAGE: 50,
  LINEAR_LIMIT: 50
}))
import { useMobileTasksTaskListLoading } from './use-mobile-tasks-task-list-loading'
it('reuses loaded GitLab rows, forces refresh and isolates changed filters', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(
    rpcSuccess({
      items: [
        {
          id: 'mr:1',
          type: 'mr',
          number: 1,
          title: 'Fix',
          state: 'opened',
          url: 'https://gitlab.example/mr/1',
          labels: [],
          updatedAt: '2026-11-01',
          author: 'Author'
        }
      ]
    })
  )
  const repo = { id: 'repo', path: '/repo', displayName: 'Repo' }
  const repos = [repo]
  const setItems = vi.fn()
  const loadGenerationRef = { current: 0 }
  const clientRef = { current: client }
  const effectiveRepoIds = new Set<string>()
  const ensure = async () => repos
  let load!: (options?: { silent?: boolean }) => Promise<void>
  function Probe({ filter }: { filter: string }) {
    load = useMobileTasksTaskListLoading(
      mountFixture<Parameters<typeof useMobileTasksTaskListLoading>[0]>({
        client,
        clientRef,
        connState: 'connected',
        provider: 'gitlab',
        repos,
        serverRepoList: repos,
        effectiveRepoIds,
        githubMode: 'items',
        gitlabView: 'project',
        gitlabFilter: filter,
        appliedQuery: '',
        loadGenerationRef,
        repoListEnsureLoaded: ensure,
        resetGitHubItemsState: vi.fn(),
        setItems,
        setError: vi.fn(),
        setLoading: vi.fn(),
        setRefreshing: vi.fn(),
        taskStateHydrated: true,
        tasksSupported: true
      })
    ).loadTasks
    return null
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(Probe, { filter: 'opened' }))
  })
  await act(async () => load())
  expect(client.sendRequest).toHaveBeenCalledOnce()
  expect(setItems).toHaveBeenLastCalledWith([
    expect.objectContaining({ provider: 'gitlab', title: 'Fix' })
  ])
  await act(async () => load())
  expect(client.sendRequest).toHaveBeenCalledOnce()
  await act(async () => load({ silent: true }))
  expect(client.sendRequest).toHaveBeenCalledTimes(2)
  await act(async () => tree.update(createElement(Probe, { filter: 'closed' })))
  await act(async () => load())
  expect(client.sendRequest).toHaveBeenCalledTimes(3)
  expect(client.sendRequest).toHaveBeenLastCalledWith(
    'gitlab.listWorkItems',
    expect.objectContaining({ state: 'closed' })
  )
  await act(async () => tree.unmount())
})
