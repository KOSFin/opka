import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { gitlabWorkItemDetailSchema } from './task-item-detail-reply-schema'
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
// Style modules use the task dependency barrel; keep its Expo/native imports out of this Node renderer.
vi.mock('./mobile-tasks-dependencies', async () => ({
  ...(await import('../theme/mobile-theme')),
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Platform: {
    select: (options: { android?: string; default?: string }) => options.android ?? options.default
  }
}))
import { GitLabMergeRequestMetadata } from './GitLabMergeRequestMetadata'
const detail = {
  provider: 'gitlab' as const,
  body: '',
  comments: [],
  labels: ['backend'],
  assignees: ['owner'],
  pipelineJobs: []
}
it('shows reviewers, assignees and accessible read-only changed file metadata', async () => {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(
      createElement(GitLabMergeRequestMetadata, {
        detail: {
          ...detail,
          assigneesAvailable: true,
          reviewers: [{ username: 'reviewer', name: 'Review Person' }],
          files: [
            {
              path: 'new.ts',
              oldPath: 'old.ts',
              status: 'renamed',
              additions: 3,
              deletions: 2,
              isBinary: false
            }
          ]
        }
      })
    )
  })
  expect(JSON.stringify(tree.toJSON())).toContain('owner')
  expect(JSON.stringify(tree.toJSON())).toContain('Review Person (@reviewer)')
  const button = tree.root.findAllByType('Pressable')[0]!
  expect(button.props.accessibilityState).toEqual({ expanded: false })
  await act(async () => button.props.onPress())
  expect(button.props.accessibilityState).toEqual({ expanded: true })
  const rendered = JSON.stringify(tree.toJSON())
  for (const text of ['new.ts', 'old.ts', 'renamed', '+3', '−2']) {
    expect(rendered).toContain(text)
  }
  expect(tree.root.findAllByType('Pressable')).toHaveLength(1)
  await act(async () => tree.unmount())
})
it('distinguishes an older host missing fields from a confirmed empty list', async () => {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(
      createElement(GitLabMergeRequestMetadata, {
        detail: { ...detail, assignees: [], assigneesAvailable: false }
      })
    )
  })
  expect(JSON.stringify(tree.toJSON())).toContain('Unavailable on this host')
  expect(tree.root.findAllByType('Pressable')[0]!.props.disabled).toBe(true)
  await act(async () =>
    tree.update(
      createElement(GitLabMergeRequestMetadata, {
        detail: { ...detail, assignees: [], assigneesAvailable: true, reviewers: [], files: [] }
      })
    )
  )
  expect(JSON.stringify(tree.toJSON())).not.toContain('Unavailable on this host')
  expect(JSON.stringify(tree.toJSON())).toContain('None')
  await act(async () => tree.unmount())
})
it('salvages metadata rows and excludes large raw diffs from the mobile payload', () => {
  const parsed = gitlabWorkItemDetailSchema.parse({
    reviewers: [{ username: 'valid' }, { username: 12 }],
    files: [{ path: 'file', additions: 2, diff: 'raw diff' }, { path: 1 }]
  })
  expect(parsed?.reviewers).toEqual([{ username: 'valid' }])
  expect(parsed?.files).toEqual([{ path: 'file', additions: 2 }])
})
