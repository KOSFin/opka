// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { RepoGitAuthor } from '../../../../shared/repo-git-author'
import { RepositoryGitAuthorSection } from './RepositoryGitAuthorSection'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

const repo: Repo = {
  id: 'repo-a',
  path: '/synthetic/a',
  displayName: 'A',
  badgeColor: '#000000',
  addedAt: 0,
  executionHostId: 'local'
}
const author: RepoGitAuthor = {
  name: { effective: 'Alice', local: 'Alice', origin: 'local' },
  email: { effective: 'alice@example.test', local: 'alice@example.test', origin: 'local' }
}
let root: Root
let container: HTMLDivElement
let getGitAuthor: ReturnType<typeof vi.fn>
let updateGitAuthor: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  getGitAuthor = vi.fn(async () => author)
  updateGitAuthor = vi.fn(async () => author)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { repos: { getGitAuthor, updateGitAuthor } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderRepo(nextRepo: Repo): Promise<void> {
  await act(async () => {
    root.render(<RepositoryGitAuthorSection repo={nextRepo} forceVisible />)
  })
}

describe('repository Git author owner lifetime', () => {
  it('keeps an unsaved author edit across same-owner metadata refresh', async () => {
    await renderRepo(repo)
    const input = container.querySelector<HTMLInputElement>('#author-name-repo-a')
    if (!input) {
      throw new Error('Author input missing')
    }
    act(() => {
      fireEvent.change(input, { target: { value: 'Draft Author' } })
    })
    await renderRepo({ ...repo, displayName: 'A renamed', addedAt: 42 })
    expect(input.value).toBe('Draft Author')
    expect(getGitAuthor).toHaveBeenCalledTimes(1)
  })

  it('reloads the author when repository path changes', async () => {
    await renderRepo(repo)
    await renderRepo({ ...repo, path: '/synthetic/new' })
    expect(getGitAuthor).toHaveBeenCalledTimes(2)
  })
})
