import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../platform/random-v4-uuid', () => ({
  randomV4Uuid: () => '11111111-1111-4111-8111-111111111111'
}))
import { ProjectTaskEditor } from './ProjectTaskEditor'

it('preserves the edited revision fence when background hydration reports a newer plan', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess({}))
  const task = {
    id: 'task-1',
    title: 'Original',
    revision: 'a'.repeat(64),
    body: '# Goal\nOriginal',
    content: '---\nschema: 1\nid: task-1\ntitle: Original\n---\n# Goal\nOriginal'
  }
  const props = {
    client,
    connected: true,
    worktree: 'path:/project',
    executionHostId: 'local',
    task,
    onDone: vi.fn(),
    onCancel: vi.fn()
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(ProjectTaskEditor, props))
  })
  await act(async () =>
    tree.root
      .findAllByType('TextInput')
      .find((n) => n.props.accessibilityLabel === 'Task details')
      ?.props.onChangeText('# Goal\nMy unsaved change')
  )
  await act(async () =>
    tree.update(
      createElement(ProjectTaskEditor, {
        ...props,
        task: { ...task, revision: 'b'.repeat(64), body: '# Goal\nOther edit' }
      })
    )
  )
  await act(async () =>
    tree.root
      .findAllByType('Pressable')
      .find((n) => n.props.onPress && n.props.disabled === false)
      ?.props.onPress()
  )
  expect(client.sendRequest).toHaveBeenCalledWith(
    'projectTask.update',
    expect.objectContaining({
      id: 'task-1',
      revision: 'a'.repeat(64),
      expectedExecutionHostId: 'local',
      content: expect.stringContaining('My unsaved change')
    })
  )
  await act(async () => tree.unmount())
})

it.each(['client', 'worktree', 'host', 'generation'])(
  'refuses an old draft after its %s changes',
  async (change) => {
    let generation = 0
    const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
    const nextClient = new FakeSession('connected')
    const props = {
      client,
      connected: true,
      worktree: 'path:/original',
      executionHostId: 'local',
      sources: [{ id: 'tasks', path: '/tasks' }],
      onDone: vi.fn(),
      onCancel: vi.fn()
    }
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(createElement(ProjectTaskEditor, props))
    })
    const save = tree.root
      .findAllByType('Pressable')
      .find((node) =>
        node.findAllByType('Text').some((text) => text.children.join('') === 'Save task')
      )!
    if (change === 'generation') {
      generation += 1
    }
    await act(async () =>
      tree.update(
        createElement(ProjectTaskEditor, {
          ...props,
          client: change === 'client' ? nextClient : client,
          worktree: change === 'worktree' ? 'path:/other' : props.worktree,
          executionHostId: change === 'host' ? 'runtime:other' : props.executionHostId
        })
      )
    )
    await act(async () => save.props.onPress())
    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(nextClient.sendRequest).not.toHaveBeenCalled()
    expect(props.onDone).not.toHaveBeenCalled()
    expect(JSON.stringify(tree.toJSON())).toContain('Project or host changed')
    await act(async () => tree.unmount())
  }
)

it('ignores completion when the editor now belongs to another project', async () => {
  const client = new FakeSession('connected')
  let finish!: (value: ReturnType<typeof rpcSuccess>) => void
  client.sendRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const props = {
    client,
    connected: true,
    worktree: 'path:/a',
    executionHostId: 'local',
    sources: [{ id: 'tasks', path: '/tasks' }],
    onDone: vi.fn(),
    onCancel: vi.fn()
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(ProjectTaskEditor, props))
  })
  await act(async () => {
    tree.root
      .findAllByType('TextInput')
      .find((node) => node.props.accessibilityLabel === 'Task title')
      ?.props.onChangeText('New task')
    tree.root
      .findAllByType('TextInput')
      .find((node) => node.props.accessibilityLabel === 'Task goal')
      ?.props.onChangeText('Goal')
    tree.root
      .findAllByType('TextInput')
      .find((node) => node.props.accessibilityLabel === 'Task acceptance criteria')
      ?.props.onChangeText('Verified')
  })
  await act(async () => {
    tree.root
      .findAllByType('Pressable')
      .find((node) =>
        node.findAllByType('Text').some((text) => text.children.join('') === 'Save task')
      )
      ?.props.onPress()
  })
  expect(client.sendRequest).toHaveBeenCalledOnce()
  await act(async () =>
    tree.update(createElement(ProjectTaskEditor, { ...props, worktree: 'path:/b' }))
  )
  await act(async () => finish(rpcSuccess({})))
  expect(props.onDone).not.toHaveBeenCalled()
  await act(async () => tree.unmount())
})
