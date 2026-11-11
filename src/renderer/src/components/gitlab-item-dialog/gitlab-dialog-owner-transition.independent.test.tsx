// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitLabWorkItem, GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'
import type { GitLabPrimaryActions } from './use-gitlab-primary-actions'

const api = vi.hoisted(() => ({ details: vi.fn(), close: vi.fn() }))
const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))
vi.mock('./gitlab-item-dialog-view', () => ({
  GitLabItemDialogView: ({
    item,
    state,
    primaryActions,
    updateCommentDraft
  }: {
    item: GitLabWorkItem | null
    state: GitLabItemDialogState
    primaryActions: GitLabPrimaryActions
    updateCommentDraft: (value: string) => void
  }) => (
    <div>
      <span data-testid="selected">{item?.title ?? 'closed'}</span>
      <span data-testid="detail">{state.details?.item.title ?? 'none'}</span>
      <span data-testid="error">{state.error ?? 'none'}</span>
      <input
        aria-label="Draft"
        value={state.commentDraft}
        onChange={(event) => updateCommentDraft(event.target.value)}
      />
      <button onClick={() => void primaryActions.handleClose()}>Close current MR</button>
    </div>
  )
}))

import GitLabItemDialog from '../GitLabItemDialog'

const a: GitLabWorkItem = {
  id: 'same-id',
  type: 'mr',
  number: 7,
  title: 'A shell',
  state: 'opened',
  url: 'https://fixture.invalid/a',
  labels: [],
  updatedAt: '2026-11-11',
  author: 'fixture',
  repoId: 'a'
}
const b: GitLabWorkItem = {
  ...a,
  title: 'B shell',
  repoId: 'b',
  url: 'https://fixture.invalid/b'
}

function detail(item: GitLabWorkItem): GitLabWorkItemDetails {
  const { repoId: _repoId, ...providerItem } = item
  return {
    item: { ...providerItem, title: `${item.title} detail` },
    body: '',
    comments: [],
    files: [],
    pipelineJobs: []
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function dialog(item: GitLabWorkItem, repoPath: string) {
  const host = item.repoId === 'a' ? 'host-a' : 'host-b'
  return (
    <GitLabItemDialog
      item={item}
      repoPath={repoPath}
      repoId={item.repoId}
      sourceContext={{
        kind: 'task-source',
        provider: 'gitlab',
        projectId: `synthetic-${item.repoId}`,
        hostId: toRuntimeExecutionHostId(host),
        repoId: item.repoId
      }}
      onClose={vi.fn()}
    />
  )
}

beforeEach(() => {
  api.details.mockReset()
  api.close.mockReset()
  api.close.mockResolvedValue({ ok: false, error: 'fixture refusal' })
  rpc.call.mockReset()
  rpc.call.mockImplementation(
    (
      target: { kind: string; environmentId: string },
      method: string,
      params: { repo: string; repoId: string }
    ) => {
      const expectedHost = params.repoId === 'a' ? 'host-a' : 'host-b'
      if (
        target.kind !== 'environment' ||
        target.environmentId !== expectedHost ||
        params.repo !== `id:${params.repoId}`
      ) {
        throw new Error('Synthetic GitLab call escaped repository owner')
      }
      if (method === 'gitlab.workItemDetails') {
        return api.details(params)
      }
      if (method === 'gitlab.updateMRState') {
        return api.close(params)
      }
      throw new Error(`Unexpected synthetic GitLab method: ${method}`)
    }
  )
})
afterEach(cleanup)

it('keys the actual caller by repository and keeps mutation and draft on B through pending, error and A-B-A', async () => {
  const pendingB = deferred<GitLabWorkItemDetails | null>()
  api.details.mockImplementation(({ repoId }: { repoId: string }) =>
    repoId === 'a' ? Promise.resolve(detail(a)) : pendingB.promise
  )
  const { rerender } = render(dialog(a, '/synthetic/a'))
  await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('A shell detail'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), {
    target: { value: 'A private draft' }
  })
  rerender(dialog(b, '/synthetic/b'))
  expect(screen.getByTestId('selected').textContent).toBe('B shell')
  expect(screen.getByTestId('detail').textContent).toBe('none')
  expect(screen.getByRole('textbox', { name: 'Draft' }).getAttribute('value')).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Close current MR' }))
  await waitFor(() =>
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host-b' },
      'gitlab.updateMRState',
      expect.objectContaining({ repo: 'id:b', repoId: 'b', repoPath: '/synthetic/b', iid: 7 }),
      expect.anything()
    )
  )
  expect(api.close).not.toHaveBeenCalledWith(expect.objectContaining({ repoId: 'a' }))
  await act(async () => pendingB.resolve(null))
  await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('Item not found.'))
  expect(screen.getByTestId('detail').textContent).toBe('none')
  rerender(dialog(a, '/synthetic/a'))
  expect(screen.getByTestId('detail').textContent).toBe('none')
  await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('A shell detail'))
  expect(screen.getByRole('textbox', { name: 'Draft' }).getAttribute('value')).toBe('')
})

it('drops late A detail after a same-number MR switches host/repo/type to B', async () => {
  const pendingA = deferred<GitLabWorkItemDetails>()
  const issueB: GitLabWorkItem = { ...b, type: 'issue' }
  api.details.mockImplementation(({ repoId }: { repoId: string }) =>
    repoId === 'a' ? pendingA.promise : Promise.resolve(detail(issueB))
  )
  const { rerender } = render(dialog(a, '/synthetic/host-a'))
  await waitFor(() =>
    expect(rpc.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host-a' },
      'gitlab.workItemDetails',
      expect.objectContaining({ repo: 'id:a', type: 'mr' }),
      expect.anything()
    )
  )
  rerender(dialog(issueB, '/synthetic/host-b'))
  await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('B shell detail'))
  await act(async () => pendingA.resolve(detail(a)))
  expect(screen.getByTestId('detail').textContent).toBe('B shell detail')
  expect(screen.getByTestId('error').textContent).toBe('none')
})
