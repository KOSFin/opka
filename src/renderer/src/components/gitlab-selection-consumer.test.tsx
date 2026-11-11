// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskProvider } from '../../../shared/task-providers'
import { TooltipProvider } from './ui/tooltip'
import { TaskPageGitLabItemList } from './task-page/gitlab/ItemList'
import type { TaskPageSourceAvailabilityModel } from './use-task-page-source-availability'
import { useTaskPageProviderState } from './use-task-page-provider-state'
import { useTaskPageGitLabLoading } from './use-task-page-gitlab-loading'

const listMRs = vi.fn()
const listIssues = vi.fn()
const repoA: Repo = {
  id: 'alpha',
  path: '/projects/alpha',
  displayName: 'Alpha',
  badgeColor: '',
  addedAt: 1,
  kind: 'git'
}
const repoB: Repo = {
  id: 'bravo',
  path: '/projects/bravo',
  displayName: 'Bravo',
  badgeColor: '',
  addedAt: 2,
  kind: 'git'
}

function item(id: string): GitLabWorkItem {
  return {
    id,
    type: 'mr',
    number: id === 'A' ? 1 : 2,
    title: `${id} work`,
    state: 'opened',
    url: `https://gitlab.example.test/group/${id}`,
    labels: [],
    updatedAt: '2026-11-10',
    author: 'review',
    repoId: id === 'A' ? repoA.id : repoB.id
  }
}

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function GitLabConsumer() {
  const [selectedRepoId, selectRepo] = useState(repoA.id)
  const [taskSource, setTaskSource] = useState<TaskProvider>('gitlab')
  const selectedRepos = selectedRepoId === repoA.id ? [repoA] : [repoB]
  const availability = {
    settings: null,
    pageData: { taskSource: 'gitlab' },
    selectedRepos,
    selectedReposKey: selectedRepoId,
    primaryRepo: selectedRepos[0],
    visibleTaskProviders: ['github', 'gitlab'],
    preferredTaskSource: 'gitlab',
    taskSource,
    setTaskSource
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every field read by the provider and loading hooks; unrelated upstream fields are never accessed.
  const provider = useTaskPageProviderState(availability as TaskPageSourceAvailabilityModel)
  const model = useTaskPageGitLabLoading(provider)
  return (
    <>
      <button onClick={() => selectRepo(repoA.id)}>Select A</button>
      <button onClick={() => selectRepo(repoB.id)}>Select B</button>
      <button onClick={() => model.setGitlabRefreshNonce((current) => current + 1)}>Refresh</button>
      <button onClick={() => model.setGitlabView('issues')}>Issues</button>
      <button onClick={() => model.setGitlabView('mrs')}>MRs</button>
      <button onClick={() => model.setGitlabFilter('closed')}>Closed</button>
      <TooltipProvider>
        <TaskPageGitLabItemList
          model={{
            ...model,
            openGitLabDetailPage: vi.fn(),
            handleUseGitLabItem: vi.fn()
          }}
        />
      </TooltipProvider>
    </>
  )
}

beforeEach(() => {
  listMRs.mockReset()
  listIssues.mockReset()
  Object.assign(window, { api: { gl: { listMRs, listIssues } } })
})
afterEach(cleanup)

it('projects only the selected GitLab project into rows and their actions', async () => {
  const second = pending<{ items: GitLabWorkItem[]; error?: { message: string } }>()
  listMRs.mockImplementation(({ repoId }: { repoId: string }) =>
    repoId === repoA.id ? Promise.resolve({ items: [item('A')] }) : second.promise
  )
  listIssues.mockResolvedValue({ items: [] })
  render(<GitLabConsumer />)
  await waitFor(() => expect(screen.getByText('A work')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Start workspace from MR 1' })).toBeTruthy()

  fireEvent.click(screen.getByText('Select B'))
  expect(screen.queryByText('A work')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Start workspace from MR 1' })).toBeNull()
  await act(async () => second.resolve({ items: [item('B')] }))
  await waitFor(() => expect(screen.getByText('B work')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Start workspace from MR 2' })).toBeTruthy()

  fireEvent.click(screen.getByText('Issues'))
  expect(screen.queryByText('B work')).toBeNull()
  fireEvent.click(screen.getByText('MRs'))
  expect(screen.getByText('B work')).toBeTruthy()
  fireEvent.click(screen.getByText('Closed'))
  expect(screen.queryByText('B work')).toBeNull()
})

it('keeps same-project rows through refresh, then clears them for error and empty results', async () => {
  const refresh = pending<{ items: GitLabWorkItem[]; error?: { message: string } }>()
  listMRs
    .mockResolvedValueOnce({ items: [item('A')] })
    .mockImplementationOnce(() => refresh.promise)
    .mockResolvedValueOnce({ items: [], error: { message: 'Project unavailable' } })
    .mockResolvedValueOnce({ items: [] })
  render(<GitLabConsumer />)
  await waitFor(() => expect(screen.getByText('A work')).toBeTruthy())
  fireEvent.click(screen.getByText('Refresh'))
  expect(screen.getByText('A work')).toBeTruthy()
  await act(async () => refresh.resolve({ items: [item('A')] }))
  expect(screen.getByText('A work')).toBeTruthy()
  fireEvent.click(screen.getByText('Select B'))
  expect(screen.queryByText('A work')).toBeNull()
  await waitFor(() => expect(screen.getByText('Project unavailable')).toBeTruthy())
  expect(screen.queryByText('A work')).toBeNull()
  fireEvent.click(screen.getByText('Refresh'))
  await waitFor(() => expect(screen.queryByText('Project unavailable')).toBeNull())
  expect(screen.queryByText('A work')).toBeNull()
})
