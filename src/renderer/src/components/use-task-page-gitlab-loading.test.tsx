// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

const rpc = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import {
  GITLAB_TASK_FETCH_CONCURRENCY,
  useTaskPageGitLabLoading
} from './use-task-page-gitlab-loading'

const serverRepo: Repo = {
  id: 'server-repo',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'runtime:build-box'
}
const glListIssues = vi.fn()

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ items: [{ id: 'i1', updatedAt: '2026-10-01' }] })
  glListIssues.mockReset().mockRejectedValue(new Error('Access denied: unknown repository path'))
  Object.assign(window, { api: { gl: { listIssues: glListIssues } } })
})

afterEach(cleanup)

describe('useTaskPageGitLabLoading', () => {
  it('lists a server-owned repo on its server (#14603)', async () => {
    const setGitlabItems = vi.fn()
    const setGitlabError = vi.fn()
    renderHook(() =>
      useTaskPageGitLabLoading({
        selectedRepos: [serverRepo],
        selectedReposKey: 'server-repo',
        primaryRepo: serverRepo,
        taskSource: 'gitlab',
        setGitlabItems,
        setGitlabLoading: vi.fn(),
        setGitlabError,
        gitlabRefreshNonce: 0,
        gitlabView: 'issues',
        setGitlabTodos: vi.fn(),
        setGitlabTodosLoading: vi.fn(),
        activeGitlabFilter: 'opened'
      })
    )

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(glListIssues).not.toHaveBeenCalled()
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'build-box' },
      'gitlab.listIssues',
      expect.objectContaining({ repo: 'id:server-repo', state: 'opened' }),
      expect.anything()
    )
    expect(setGitlabItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'i1', repoId: 'server-repo' })
    ])
    expect(setGitlabError).not.toHaveBeenCalledWith(expect.stringContaining('Access denied'))
  })

  function manyServerRepos(count: number): Repo[] {
    return Array.from({ length: count }, (_, i) => ({
      ...serverRepo,
      id: `server-repo-${i}`,
      path: `/srv/app-${i}`,
      displayName: `app-${i}`
    }))
  }

  function renderIssuesHook(repos: Repo[], setGitlabItems = vi.fn(), setGitlabError = vi.fn()) {
    return renderHook(() =>
      useTaskPageGitLabLoading({
        selectedRepos: repos,
        selectedReposKey: repos.map((repo) => repo.id).join(','),
        primaryRepo: repos[0],
        taskSource: 'gitlab',
        setGitlabItems,
        setGitlabLoading: vi.fn(),
        setGitlabError,
        gitlabRefreshNonce: 0,
        gitlabView: 'issues',
        setGitlabTodos: vi.fn(),
        setGitlabTodosLoading: vi.fn(),
        activeGitlabFilter: 'opened'
      })
    )
  }

  it('bounds concurrent per-repo GitLab calls for large all-projects selections (#30133)', async () => {
    const repos = manyServerRepos(20)
    let inFlight = 0
    let maxInFlight = 0
    rpc.call.mockImplementation(async (_target, _method, params: { repo: string }) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return { items: [{ id: `item-${params.repo}`, updatedAt: '2026-10-01' }] }
    })
    const setGitlabItems = vi.fn()

    renderIssuesHook(repos, setGitlabItems)

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(rpc.call).toHaveBeenCalledTimes(repos.length)
    expect(maxInFlight).toBe(GITLAB_TASK_FETCH_CONCURRENCY)
    expect(setGitlabItems.mock.lastCall?.[0]).toHaveLength(repos.length)
    expect(setGitlabItems).toHaveBeenLastCalledWith(
      expect.arrayContaining(repos.map((repo) => expect.objectContaining({ repoId: repo.id })))
    )
  })

  it('stops starting GitLab calls once the selection goes stale (#30133)', async () => {
    const repos = manyServerRepos(20)
    const pending: (() => void)[] = []
    rpc.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ items: [] }))
        })
    )
    const setGitlabItems = vi.fn()

    const { unmount } = renderIssuesHook(repos, setGitlabItems)

    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(GITLAB_TASK_FETCH_CONCURRENCY))
    unmount()
    for (const resolve of pending.splice(0)) {
      resolve()
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rpc.call).toHaveBeenCalledTimes(GITLAB_TASK_FETCH_CONCURRENCY)
    expect(setGitlabItems).not.toHaveBeenCalled()
  })

  it('shows a selected project failure alongside another project’s valid rows', async () => {
    const repos = manyServerRepos(2)
    rpc.call.mockImplementation(async (_target, _method, params: { repo: string }) =>
      params.repo === 'id:server-repo-0'
        ? { items: [{ id: 'visible', updatedAt: '2026-10-01' }] }
        : { items: [], error: { type: 'auth', message: 'Project 2 requires sign in' } }
    )
    const setGitlabItems = vi.fn()
    const setGitlabError = vi.fn()

    renderIssuesHook(repos, setGitlabItems, setGitlabError)

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(rpc.call).toHaveBeenCalledTimes(2)
    expect(setGitlabItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'visible', repoId: 'server-repo-0' })
    ])
    expect(setGitlabError).toHaveBeenLastCalledWith('Project 2 requires sign in')
  })

  it('refuses an old host reply without items while preserving another project’s rows', async () => {
    const repos = manyServerRepos(2)
    rpc.call.mockImplementation(async (_target, _method, params: { repo: string }) =>
      params.repo === 'id:server-repo-0'
        ? { items: [{ id: 'visible', updatedAt: '2026-10-01' }] }
        : { legacyCount: 1 }
    )
    const setGitlabItems = vi.fn()
    const setGitlabError = vi.fn()

    renderIssuesHook(repos, setGitlabItems, setGitlabError)

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(setGitlabItems).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'visible', repoId: 'server-repo-0' })
    ])
    expect(setGitlabError).toHaveBeenLastCalledWith(
      'GitLab host returned an incompatible issue list.'
    )
  })

  it('queries only selected host projects and discards their late results after a switch', async () => {
    const foreignRepo = { ...serverRepo, id: 'foreign', path: '/srv/foreign' }
    const repos = [
      { ...serverRepo, id: 'tracker-a', path: '/srv/tracker-a' },
      { ...serverRepo, id: 'tracker-b', path: '/srv/tracker-b' },
      foreignRepo
    ]
    const pending = new Map<string, (result: { items: unknown[] }) => void>()
    rpc.call.mockImplementation(
      (
        _target,
        method: string,
        params: { repo: string; state: 'opened'; page: number; perPage: number }
      ) => {
        expect(method).toBe('gitlab.listMRs')
        return new Promise((resolve) => {
          pending.set(params.repo, resolve)
        })
      }
    )
    const setGitlabItems = vi.fn()
    const { rerender } = renderHook(
      ({ selected }: { selected: Repo[] }) =>
        useTaskPageGitLabLoading({
          selectedRepos: selected,
          selectedReposKey: selected.map((repo) => repo.id).join(','),
          primaryRepo: selected[0],
          taskSource: 'gitlab',
          setGitlabItems,
          setGitlabLoading: vi.fn(),
          setGitlabError: vi.fn(),
          gitlabRefreshNonce: 0,
          gitlabView: 'mrs',
          setGitlabTodos: vi.fn(),
          setGitlabTodosLoading: vi.fn(),
          activeGitlabFilter: 'opened'
        }),
      { initialProps: { selected: repos.slice(0, 2) } }
    )
    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(2))
    expect(rpc.call.mock.calls.map((call) => call[2].repo)).toEqual([
      'id:tracker-a',
      'id:tracker-b'
    ])
    rerender({ selected: [foreignRepo] })
    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(3))
    pending.get('id:tracker-a')?.({ items: [{ id: 'old-a', updatedAt: '2026-11-10' }] })
    pending.get('id:tracker-b')?.({ items: [{ id: 'old-b', updatedAt: '2026-11-10' }] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setGitlabItems).not.toHaveBeenCalled()
    pending.get('id:foreign')?.({ items: [{ id: 'current', updatedAt: '2026-11-10' }] })
    await waitFor(() =>
      expect(setGitlabItems).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: 'current', repoId: 'foreign' })
      ])
    )
    expect(rpc.call.mock.calls.map((call) => call[2].repo)).toEqual([
      'id:tracker-a',
      'id:tracker-b',
      'id:foreign'
    ])
  })
})
