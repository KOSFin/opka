// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
import { useGitLabItemDialogState } from './use-gitlab-item-dialog-state'

afterEach(cleanup)

function details(id: string): GitLabWorkItemDetails {
  return {
    item: {
      id,
      type: 'mr',
      number: id === 'A' ? 1 : 2,
      title: `Title ${id}`,
      state: 'opened',
      url: `https://gitlab.example.test/team/${id}`,
      labels: [`label-${id}`],
      updatedAt: '2026-11-10',
      author: 'review'
    },
    body: `Body ${id}`,
    comments: [],
    files: [],
    pipelineJobs: []
  }
}

it('hides prior item details immediately and ignores their late writes', () => {
  const { result, rerender } = renderHook(
    ({ scopeKey }: { scopeKey: string }) => useGitLabItemDialogState(scopeKey),
    { initialProps: { scopeKey: 'A' } }
  )
  act(() => {
    result.current.setDetails(details('A'))
    result.current.setLoading(false)
    result.current.setEditingDetails(true)
    result.current.updateCommentDraft('Draft for A')
  })
  const oldSetDetails = result.current.setDetails
  const oldSetError = result.current.setError
  const oldSetLoading = result.current.setLoading
  expect(result.current.details?.item.title).toBe('Title A')

  rerender({ scopeKey: 'B' })
  expect(result.current.details).toBeNull()
  expect(result.current.loading).toBe(true)
  expect(result.current.error).toBeNull()
  expect(result.current.commentDraft).toBe('')
  expect(result.current.editingDetails).toBe(false)

  act(() => {
    result.current.setDetails(details('B'))
    result.current.setLoading(false)
    oldSetDetails(details('A'))
    oldSetError('Old item failed')
    oldSetLoading(true)
  })
  expect(result.current.details?.item.title).toBe('Title B')
  expect(result.current.error).toBeNull()
  expect(result.current.loading).toBe(false)
  rerender({ scopeKey: 'B' })
  expect(result.current.details?.item.title).toBe('Title B')

  act(() => {
    result.current.setDetails(null)
    result.current.setError('Item not found.')
  })
  expect(result.current.details).toBeNull()
  expect(result.current.error).toBe('Item not found.')

  rerender({ scopeKey: 'A' })
  expect(result.current.details).toBeNull()
  act(() => oldSetDetails(details('A')))
  expect(result.current.details).toBeNull()
  act(() => result.current.setDetails(details('A')))
  expect(result.current.details?.item.title).toBe('Title A')
})
