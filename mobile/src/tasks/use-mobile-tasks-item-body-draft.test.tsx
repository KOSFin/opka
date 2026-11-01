import { createElement, useState } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { DetailPayload } from './mobile-tasks-provider-detail-types'
vi.mock('./mobile-tasks-dependencies', async () => ({
  useEffect: (await import('react')).useEffect
}))
import { useMobileTasksItemDetailMetadataEffects } from './use-mobile-tasks-item-detail-metadata-effects'
it('does not overwrite an edited body when read-only detail metadata refreshes', async () => {
  let setDraft: (value: string) => void = () => {}
  let observed = ''
  const noop = () => {}
  function Probe({ body }: { body: string }) {
    const [draft, updateDraft] = useState('')
    setDraft = updateDraft
    observed = draft
    const detailPayload: DetailPayload = {
      provider: 'gitlab',
      body,
      labels: [],
      comments: [],
      assignees: [],
      pipelineJobs: []
    }
    useMobileTasksItemDetailMetadataEffects({
      actionItem: null,
      client: null,
      detailPayload,
      setItemBodyDraft: updateDraft,
      setItemAssignableUsers: noop,
      setItemAssignableUsersError: noop,
      setItemAssignableUsersLoading: noop,
      setItemAvailableLabels: noop,
      setItemLabelsError: noop,
      setItemLabelsLoading: noop,
      tasksSupported: false
    })
    return null
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(Probe, { body: 'Original body' }))
  })
  expect(observed).toBe('Original body')
  await act(async () => setDraft('Unsaved edit'))
  await act(async () => tree.update(createElement(Probe, { body: 'Refreshed body' })))
  expect(observed).toBe('Unsaved edit')
  await act(async () => tree.unmount())
})
