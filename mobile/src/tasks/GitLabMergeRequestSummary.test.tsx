import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { GitLabWorkItem } from './mobile-tasks-provider-detail-types'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('./mobile-tasks-dependencies', async () => ({
  ...(await import('../theme/mobile-theme')),
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Platform: {
    select: (options: { android?: string; default?: string }) => options.android ?? options.default
  }
}))

import { GitLabMergeRequestSummary } from './GitLabMergeRequestSummary'

const mr: GitLabWorkItem = {
  id: 'mr-1',
  type: 'mr',
  number: 7,
  title: 'Synthetic review',
  state: 'opened',
  url: 'https://gitlab.example.test/group/app/-/merge_requests/7',
  labels: [],
  updatedAt: '2026-11-09',
  author: 'reviewer',
  branchName: 'feature/app',
  baseRefName: 'main',
  projectRef: { host: 'gitlab.example.test', path: 'group/app' },
  repoId: 'repo-1',
  repoName: 'app'
}

it('shows the provider source and copies only the selected MR branch', async () => {
  const onCopySourceBranch = vi.fn()
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(GitLabMergeRequestSummary, { item: mr, onCopySourceBranch }))
  })

  const rendered = JSON.stringify(tree.toJSON())
  expect(rendered).toContain('gitlab.example.test/group/app')
  expect(rendered).toContain('feature/app')
  expect(rendered).toContain('main')
  const copy = tree.root.findByProps({ accessibilityLabel: 'Copy source branch' })
  await act(async () => copy.props.onPress())
  expect(onCopySourceBranch).toHaveBeenCalledExactlyOnceWith('feature/app')
  await act(async () => tree.unmount())
})

it('keeps old-peer missing source and branch fields absent', async () => {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(
      createElement(GitLabMergeRequestSummary, {
        item: { ...mr, projectRef: undefined, branchName: undefined, baseRefName: undefined },
        onCopySourceBranch: vi.fn()
      })
    )
  })

  const rendered = JSON.stringify(tree.toJSON())
  expect(rendered).not.toContain('gitlab.example.test/group/app')
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Copy source branch' })).toHaveLength(0)
  await act(async () => tree.unmount())
})
