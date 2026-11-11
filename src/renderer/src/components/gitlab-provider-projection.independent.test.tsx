// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskProvider } from '../../../shared/task-providers'
import { buildSelectedReposKey } from './task-page-work-item-pagination'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
import type { TaskPageSourceAvailabilityModel } from './use-task-page-source-availability'
import { useTaskPageProviderState } from './use-task-page-provider-state'
import { useTaskPageGitLabLoading } from './use-task-page-gitlab-loading'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))
const repoA: Repo = {
  id: 'independent-a',
  path: '/synthetic/a',
  displayName: 'A',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'runtime:host-a',
  kind: 'git'
}
const repoB: Repo = {
  ...repoA,
  id: 'independent-b',
  path: '/synthetic/b',
  displayName: 'B',
  executionHostId: 'runtime:host-b'
}

function item(repo: Repo): GitLabWorkItem {
  return {
    id: 'mr:1',
    type: 'mr',
    number: 1,
    title: `Only ${repo.displayName}`,
    state: 'opened',
    url: `https://fixture.invalid/${repo.id}`,
    labels: [],
    updatedAt: '2026-11-11T00:00:00Z',
    author: 'fixture',
    repoId: repo.id
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function useActualProjection(repo: Repo) {
  const [taskSource, setTaskSource] = useState<TaskProvider>('gitlab')
  const selectedRepos = [repo]
  const selectedReposKey = buildSelectedReposKey(selectedRepos, (entry) =>
    getTaskPageRepoSourceContext(entry, 'github')
  )
  const availability = {
    settings: null,
    pageData: { taskSource: 'gitlab' },
    selectedRepos,
    selectedReposKey,
    primaryRepo: repo,
    visibleTaskProviders: ['github', 'gitlab'],
    preferredTaskSource: 'gitlab',
    taskSource,
    setTaskSource
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the fields read by the provider and loading hooks; unrelated availability fields are not accessed.
  const provider = useTaskPageProviderState(availability as TaskPageSourceAvailabilityModel)
  return useTaskPageGitLabLoading(provider)
}

type Target = { kind: 'environment'; environmentId: string }
type Params = { repo: string }

function selectedRepo(target: Target, method: string, params: Params): Repo {
  if (method !== 'gitlab.listMRs') {
    throw new Error(`Unexpected synthetic GitLab method: ${method}`)
  }
  if (target.kind !== 'environment') {
    throw new Error('Synthetic GitLab request escaped its execution host')
  }
  if (target.environmentId === 'host-a' && params.repo === `id:${repoA.id}`) {
    return repoA
  }
  if (target.environmentId === 'host-b' && params.repo === `id:${repoB.id}`) {
    return repoB
  }
  throw new Error('Synthetic GitLab request crossed project or host ownership')
}

beforeEach(() => {
  rpc.call.mockReset()
})
afterEach(cleanup)

it('hides A rows immediately for B host/project and clears B on return to A', async () => {
  const firstA = deferred<{ items: GitLabWorkItem[] }>()
  const secondB = deferred<{ items: GitLabWorkItem[] }>()
  let aCalls = 0
  rpc.call.mockImplementation((target: Target, method: string, params: Params) => {
    if (selectedRepo(target, method, params) === repoA) {
      aCalls += 1
      return aCalls === 1 ? Promise.resolve({ items: [item(repoA)] }) : firstA.promise
    }
    return secondB.promise
  })
  const { result, rerender } = renderHook(({ repo }) => useActualProjection(repo), {
    initialProps: { repo: repoA }
  })
  expect(result.current.activeGitlabFilter).toBe('opened')
  await waitFor(() =>
    expect(result.current.displayedGitLabItems.map((row) => row.title)).toEqual(['Only A'])
  )
  rerender({ repo: repoB })
  expect(result.current.gitlabItems).toEqual([])
  expect(result.current.displayedGitLabItems).toEqual([])
  expect(result.current.gitlabLoading).toBe(true)
  await act(async () => secondB.resolve({ items: [item(repoB)] }))
  await waitFor(() =>
    expect(result.current.displayedGitLabItems.map((row) => row.title)).toEqual(['Only B'])
  )
  rerender({ repo: repoA })
  expect(result.current.displayedGitLabItems).toEqual([])
  await act(async () => firstA.resolve({ items: [item(repoA)] }))
  await waitFor(() =>
    expect(result.current.displayedGitLabItems.map((row) => row.title)).toEqual(['Only A'])
  )
})

it('ignores a late A reply after B has become the selected project', async () => {
  const lateA = deferred<{ items: GitLabWorkItem[] }>()
  rpc.call.mockImplementation((target: Target, method: string, params: Params) =>
    selectedRepo(target, method, params) === repoA
      ? lateA.promise
      : Promise.resolve({ items: [item(repoB)] })
  )
  const { result, rerender } = renderHook(({ repo }) => useActualProjection(repo), {
    initialProps: { repo: repoA }
  })
  await waitFor(() =>
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host-a' },
      'gitlab.listMRs',
      expect.objectContaining({ repo: `id:${repoA.id}` }),
      expect.anything()
    )
  )
  rerender({ repo: repoB })
  await waitFor(() =>
    expect(result.current.displayedGitLabItems.map((row) => row.title)).toEqual(['Only B'])
  )
  await act(async () => lateA.resolve({ items: [item(repoA)] }))
  expect(result.current.displayedGitLabItems.map((row) => row.title)).toEqual(['Only B'])
})

it('shows no prior rows when B returns an error or an empty list', async () => {
  rpc.call.mockImplementation((target: Target, method: string, params: Params) =>
    Promise.resolve(
      selectedRepo(target, method, params) === repoA
        ? { items: [item(repoA)] }
        : { items: [], error: { message: 'B unavailable' } }
    )
  )
  const { result, rerender } = renderHook(({ repo }) => useActualProjection(repo), {
    initialProps: { repo: repoA }
  })
  await waitFor(() => expect(result.current.displayedGitLabItems).toHaveLength(1))
  rerender({ repo: repoB })
  expect(result.current.displayedGitLabItems).toEqual([])
  await waitFor(() => expect(result.current.gitlabError).toBe('B unavailable'))
  expect(result.current.displayedGitLabItems).toEqual([])
})

it('keeps B empty after an empty owner-scoped response', async () => {
  rpc.call.mockImplementation((target: Target, method: string, params: Params) =>
    Promise.resolve(
      selectedRepo(target, method, params) === repoA ? { items: [item(repoA)] } : { items: [] }
    )
  )
  const { result, rerender } = renderHook(({ repo }) => useActualProjection(repo), {
    initialProps: { repo: repoA }
  })
  await waitFor(() => expect(result.current.displayedGitLabItems).toHaveLength(1))
  rerender({ repo: repoB })
  expect(result.current.displayedGitLabItems).toEqual([])
  await waitFor(() => expect(result.current.gitlabLoading).toBe(false))
  expect(result.current.displayedGitLabItems).toEqual([])
  expect(result.current.gitlabError).toBeNull()
})
