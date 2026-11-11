// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitLabNetworkProfile } from '../../../../shared/gitlab-network-profile'
import type * as NetworkBindingModule from './repository-git-network-binding'
import { RepositoryGitNetworkSection } from './RepositoryGitNetworkSection'

const { listAccounts, bindAccount } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  bindAccount: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
vi.mock('./repository-github-account', () => ({ listRepositoryGhBindableAccounts: listAccounts }))
vi.mock('./repository-git-network-binding', async (importOriginal) => ({
  ...(await importOriginal<typeof NetworkBindingModule>()),
  bindRepositoryGitNetworkAccount: bindAccount
}))
vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const alice: GitLabNetworkProfile = {
  id: 'a'.repeat(64),
  host: 'gitlab.example',
  user: 'alice',
  generation: 'generation-a'
}
const repoA: Repo = {
  id: 'repo-a',
  path: '/synthetic/a',
  displayName: 'A',
  badgeColor: '#000000',
  addedAt: 0,
  executionHostId: 'local'
}
const repoB: Repo = { ...repoA, id: 'repo-b', path: '/synthetic/b', displayName: 'B' }
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  listAccounts.mockReset().mockResolvedValue({ capability: 'supported', accounts: [] })
  bindAccount.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gl: { listNetworkProfiles: vi.fn(async () => [alice]) } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderRepo(repo: Repo): Promise<void> {
  await act(async () => {
    root.render(
      <RepositoryGitNetworkSection
        key={`${repo.executionHostId}:${repo.id}:${repo.path}:${JSON.stringify(repo.gitNetworkBinding)}`}
        repo={repo}
        forceVisible
      />
    )
  })
}

function accountSelect(): HTMLSelectElement {
  const select = container.querySelector('select')
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error('Git network selector missing')
  }
  return select
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes('Use selected account')
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Git network save missing')
  }
  return button
}

describe('repository Git network selection owner lifetime', () => {
  it('settles a held save after a same-owner metadata refresh', async () => {
    let release: ((repo: Repo) => void) | undefined
    bindAccount.mockReturnValue(
      new Promise<Repo>((resolve) => {
        release = resolve
      })
    )
    await renderRepo(repoA)
    act(() => {
      accountSelect().value = `gitlab:${alice.id}`
      accountSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => saveButton().click())
    await renderRepo({ ...repoA, displayName: 'A renamed', addedAt: 42 })
    expect(listAccounts).toHaveBeenCalledTimes(1)
    await act(async () => {
      release?.({ ...repoA, gitNetworkBinding: { provider: 'gitlab', ...alice } })
    })
    expect(container.textContent).toContain('GitLab · alice · gitlab.example')
    expect(container.textContent).toContain('Use selected account')
    expect(container.textContent).not.toContain('Saving…')
  })

  it('shows a held save failure after a same-owner metadata refresh', async () => {
    let reject: ((error: Error) => void) | undefined
    bindAccount.mockReturnValue(
      new Promise<Repo>((_resolve, fail) => {
        reject = fail
      })
    )
    await renderRepo(repoA)
    act(() => {
      accountSelect().value = `gitlab:${alice.id}`
      accountSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => saveButton().click())
    await renderRepo({ ...repoA, displayName: 'A renamed', addedAt: 42 })
    await act(async () => {
      reject?.(new Error('A save failed'))
    })
    expect(container.textContent).toContain('A save failed')
    expect(container.textContent).not.toContain('Saving…')
  })

  it('resets A choice for B and ignores A successful save after B takes the pane', async () => {
    let release: ((repo: Repo) => void) | undefined
    bindAccount.mockReturnValue(
      new Promise<Repo>((resolve) => {
        release = resolve
      })
    )
    await renderRepo(repoA)
    act(() => {
      accountSelect().value = `gitlab:${alice.id}`
      accountSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => saveButton().click())
    expect(bindAccount).toHaveBeenCalledWith(repoA, { provider: 'gitlab', profileId: alice.id })
    await renderRepo(repoB)
    expect(accountSelect().value).toBe('__git_network_unbound__')
    await act(async () => {
      release?.({ ...repoA, gitNetworkBinding: { provider: 'gitlab', ...alice } })
    })
    expect(container.textContent).toContain('Using existing Git configuration for this repository.')
  })

  it('ignores A failed save after B takes the pane', async () => {
    let reject: ((error: Error) => void) | undefined
    bindAccount.mockReturnValue(
      new Promise<Repo>((_resolve, fail) => {
        reject = fail
      })
    )
    await renderRepo(repoA)
    act(() => {
      accountSelect().value = `gitlab:${alice.id}`
      accountSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => saveButton().click())
    await renderRepo(repoB)
    await act(async () => {
      reject?.(new Error('A private failure'))
    })
    expect(container.textContent).not.toContain('A private failure')
    expect(accountSelect().value).toBe('__git_network_unbound__')
  })
})
