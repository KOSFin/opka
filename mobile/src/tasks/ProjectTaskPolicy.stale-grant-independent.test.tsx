import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectTaskPolicy } from './ProjectTaskPolicy'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))

let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.resetAllMocks()
})

it('removes a stale delegated grant when a manual refresh loses the host', async () => {
  const client = new FakeSession('connected')
  client.sendRequest
    .mockResolvedValueOnce({
      id: 'read-initial',
      ok: true,
      result: {
        generation: 4,
        grant: {
          schema: 1,
          binding: {
            installationId: 'installation',
            machineBinding: 'machine',
            projectId: 'project',
            root: '/synthetic',
            configRevision: 'a'.repeat(64)
          },
          actor: { key: 'verified-key', aliases: ['verified-key'] },
          actorAddress: 'term_verified',
          actions: ['approve-plan'],
          runId: null,
          taskIds: null,
          expiresAt: Date.now() + 60_000,
          generation: 4
        }
      }
    })
    .mockRejectedValueOnce(new Error('connection lost'))
  await act(async () => {
    tree = create(
      createElement(ProjectTaskPolicy, {
        client,
        connected: true,
        supported: true,
        hostId: 'host-a',
        worktree: 'folder:synthetic',
        executionHostId: 'execution-a',
        projectName: 'Synthetic',
        onChanged: vi.fn()
      })
    )
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('Delegated policy')
  expect(JSON.stringify(tree?.toJSON())).toContain('Allow agents…')
  const refresh = tree?.root.findAllByType('Pressable').at(-1)
  await act(async () => refresh?.props.onPress())
  expect(JSON.stringify(tree?.toJSON())).toContain('connection lost')
  expect(JSON.stringify(tree?.toJSON())).not.toContain('Delegated policy')
  expect(JSON.stringify(tree?.toJSON())).not.toContain('term_verified')
  expect(JSON.stringify(tree?.toJSON())).not.toContain('Allow agents…')
})
