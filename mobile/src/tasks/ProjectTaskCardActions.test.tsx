import { rpcSuccess } from '../transport/rpc-operation-test-families'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { MobileProjectTask } from './project-task-rpc'
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('./ProjectTaskEditor', () => ({ ProjectTaskEditor: 'Editor' }))
import { ProjectTaskCardActions } from './ProjectTaskCardActions'
const task: MobileProjectTask = {
  id: 'task-1',
  title: 'Task',
  revision: 'a'.repeat(64),
  path: '/task.md',
  workflow: { phase: 'draft', archived: false, revisionChanged: false, attempts: [], events: [] }
}
it.each(['worktree', 'generation'])(
  'refuses an old move picker after %s changes',
  async (change) => {
    let generation = 0
    const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
    const props = {
      client,
      connected: true,
      worktree: 'path:/a',
      executionHostId: 'local',
      task,
      body: 'Task',
      content: 'Task',
      onDone: vi.fn()
    }
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(createElement(ProjectTaskCardActions, props))
    })
    await act(async () =>
      tree.root
        .findAllByType('Pressable')
        .find((node) =>
          node.findAllByType('Text').some((text) => text.children.join('') === 'Move task')
        )
        ?.props.onPress()
    )
    const picker = tree.root.findByType('PickerModal').props
    expect(picker.options.map((option: { value: string }) => option.value)).toEqual([
      'draft',
      'active',
      'review'
    ])
    if (change === 'generation') {
      generation += 1
    }
    await act(async () =>
      tree.update(
        createElement(ProjectTaskCardActions, {
          ...props,
          worktree: change === 'worktree' ? 'path:/b' : props.worktree
        })
      )
    )
    await act(async () => picker.onSelect('review'))
    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(props.onDone).not.toHaveBeenCalled()
    await act(async () => tree.unmount())
  }
)

it('refuses Done and unknown picker values without bypassing result acceptance', async () => {
  const client = new FakeSession('connected')
  const props = {
    client,
    connected: true,
    worktree: 'path:/a',
    executionHostId: 'local',
    task,
    body: 'Task',
    content: 'Task',
    onDone: vi.fn()
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(ProjectTaskCardActions, props))
  })
  for (const phase of ['done', 'unknown']) {
    await act(async () =>
      tree.root
        .findAllByType('Pressable')
        .find((node) =>
          node.findAllByType('Text').some((text) => text.children.join('') === 'Move task')
        )
        ?.props.onPress()
    )
    await act(async () => tree.root.findByType('PickerModal').props.onSelect(phase))
  }
  expect(client.sendRequest).not.toHaveBeenCalled()
  expect(props.onDone).not.toHaveBeenCalled()
  await act(async () => tree.unmount())
})

it('derives a new owner view without retaining old busy state or delivering old completion', async () => {
  const client = new FakeSession('connected')
  let finish!: (value: ReturnType<typeof rpcSuccess>) => void
  client.sendRequest.mockResolvedValue(rpcSuccess({})).mockImplementationOnce(
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
    task,
    body: 'Task',
    content: 'Task',
    onDone: vi.fn()
  }
  let tree!: ReturnType<typeof create>
  const moveButton = () =>
    tree.root
      .findAllByType('Pressable')
      .find((node) =>
        node
          .findAllByType('Text')
          .some((text) => ['Move task', 'Saving…'].includes(text.children.join('')))
      )!
  await act(async () => {
    tree = create(createElement(ProjectTaskCardActions, props))
  })
  await act(async () => moveButton().props.onPress())
  await act(async () => {
    tree.root.findByType('PickerModal').props.onSelect('review')
  })
  expect(client.sendRequest).toHaveBeenCalledOnce()
  await act(async () =>
    tree.update(createElement(ProjectTaskCardActions, { ...props, worktree: 'path:/b' }))
  )
  expect(moveButton().props.disabled).toBe(false)
  expect(tree.root.findByType('PickerModal').props.visible).toBe(false)
  await act(async () => finish(rpcSuccess({})))
  expect(props.onDone).not.toHaveBeenCalled()
  await act(async () => moveButton().props.onPress())
  await act(async () => tree.root.findByType('PickerModal').props.onSelect('draft'))
  expect(client.sendRequest).toHaveBeenLastCalledWith(
    'projectTask.move',
    expect.objectContaining({
      worktree: 'path:/b',
      id: task.id,
      revision: task.revision,
      expectedExecutionHostId: 'local',
      phase: 'draft'
    })
  )
  expect(props.onDone).toHaveBeenCalledOnce()
  await act(async () => tree.unmount())
})
