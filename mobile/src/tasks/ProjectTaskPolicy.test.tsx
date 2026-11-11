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
const client = new FakeSession('connected')
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.resetAllMocks()
  vi.useRealTimers()
})
const props = {
  client,
  connected: true,
  supported: true,
  hostId: 'host-a',
  worktree: 'folder:synthetic',
  executionHostId: 'execution-a',
  projectName: 'Synthetic',
  onChanged: vi.fn()
}

it('leaves an old host manual and never attempts a policy RPC', async () => {
  await act(async () => {
    tree = create(createElement(ProjectTaskPolicy, { ...props, supported: false }))
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('does not support delegation')
  expect(client.sendRequest).not.toHaveBeenCalled()
})

it('discards a late policy reply after the host and project change', async () => {
  const delayed = Promise.withResolvers<{
    id: string
    ok: true
    result: { generation: number; grant: null }
  }>()
  client.sendRequest
    .mockReturnValueOnce(delayed.promise)
    .mockResolvedValueOnce({ id: 'rpc-2', ok: true, result: { generation: 7, grant: null } })
  await act(async () => {
    tree = create(createElement(ProjectTaskPolicy, props))
  })
  await act(async () => {
    tree?.update(
      createElement(ProjectTaskPolicy, {
        ...props,
        hostId: 'host-b',
        worktree: 'folder:other',
        executionHostId: 'execution-b'
      })
    )
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('generation 7')
  await act(async () =>
    delayed.resolve({ id: 'rpc-1', ok: true, result: { generation: 2, grant: null } })
  )
  expect(JSON.stringify(tree?.toJSON())).toContain('generation 7')
})

it('shows manual review when the host grant expires', async () => {
  vi.useFakeTimers()
  client.sendRequest.mockResolvedValue({
    id: 'rpc-expiry',
    ok: true,
    result: {
      generation: 3,
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
        expiresAt: Date.now() + 1_000,
        generation: 3
      }
    }
  })
  await act(async () => {
    tree = create(createElement(ProjectTaskPolicy, props))
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('Delegated policy')
  await act(async () => {
    vi.advanceTimersByTime(1_000)
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('Manual review required')
})
