import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
const mocks = vi.hoisted(() => ({ launch: vi.fn(), push: vi.fn(), supported: true }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (v: unknown) => v }
}))
vi.mock('../components/PickerModal', () => ({
  PickerModal: (props: Record<string, unknown>) => createElement('Picker', props)
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useOptionalHostProtocolGates: () => ({ hostCapabilities: ['agent.launch.v2'] })
}))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => ({ push: mocks.push }) }))
vi.mock('../session/mobile-existing-agent-launch', () => ({
  launchAgentInExistingWorkspace: mocks.launch,
  supportsMobileExistingAgentLaunch: () => mocks.supported
}))
import { ProjectTaskLaunch } from './ProjectTaskLaunch'
const task = {
  id: 't1',
  title: 'Test',
  revision: 'a'.repeat(64),
  path: 'docs/task.md',
  workflow: { phase: 'ready', archived: false, revisionChanged: false, attempts: [], events: [] }
}
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.clearAllMocks()
  mocks.supported = true
})
async function press(label: string) {
  const button = tree?.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) =>
      JSON.stringify(
        node.findAll((child) => String(child.type) === 'Text').map((child) => child.props.children)
      ).includes(label)
    )
  if (!button) {
    throw new Error(`Missing button ${label}`)
  }
  await act(async () => button.props.onPress())
}
async function setup(revision = task.revision, phase = 'ready', displayedPhase = 'ready') {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method) => {
    if (method === 'worktree.ps') {
      return rpcSuccess({
        worktrees: [
          {
            worktreeId: 'folder:test',
            displayName: 'Project',
            path: '/test',
            branch: '',
            isArchived: false
          },
          {
            worktreeId: 'folder:private',
            displayName: 'Other project',
            path: '/private',
            branch: '',
            isArchived: false
          }
        ]
      })
    }
    if (method === 'preflight.detectAgents') {
      return rpcSuccess(['codex'])
    }
    return rpcSuccess({
      revision,
      workflow: { phase, archived: false },
      executionHostId: 'runtime:test',
      text: 'Canonical task resume'
    })
  })
  await act(async () => {
    tree = create(
      createElement(ProjectTaskLaunch, {
        client,
        connected: true,
        hostId: 'h1',
        worktree: 'folder:test',
        executionHostId: 'runtime:test',
        task: { ...task, workflow: { ...task.workflow, phase: displayedPhase } }
      })
    )
  })
  return client
}
async function select() {
  await press('Work on task')
  const pickers = tree?.root.findAll((node) => String(node.type) === 'Picker') ?? []
  expect(pickers[0].props.options).toHaveLength(1)
  await act(async () => {
    pickers[0].props.onSelect('folder:test')
    pickers[1].props.onSelect('codex')
  })
}
describe('task chat launch', () => {
  it('labels an unapproved task as planning', async () => {
    await setup(task.revision, 'draft', 'draft')
    expect(JSON.stringify(tree?.toJSON())).toContain('Discuss plan')
    expect(JSON.stringify(tree?.toJSON())).not.toContain('Work on task')
  })
  it('uses explicit workspace and agent with canonical resume through existing launch service', async () => {
    await setup()
    await select()
    mocks.launch.mockResolvedValue({
      kind: 'launched',
      result: { worktreeId: 'folder:test' },
      promptDelivered: true
    })
    await press('Start task chat')
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'folder:test',
        agent: 'codex',
        prompt: { delivery: 'submit', text: expect.stringContaining('Canonical task resume') }
      })
    )
    expect(mocks.push).toHaveBeenCalledWith('/h/h1/session/folder%3Atest')
  })
  it('opens the existing workspace when a launched agent could not receive its prompt', async () => {
    await setup()
    await select()
    mocks.launch.mockResolvedValue({
      kind: 'launched',
      result: { worktreeId: 'folder:test' },
      promptDelivered: false
    })
    await press('Start task chat')
    expect(mocks.push).not.toHaveBeenCalled()
    await press('Open workspace')
    expect(mocks.push).toHaveBeenCalledWith('/h/h1/session/folder%3Atest')
  })
  it('rejects a plan changed between selection and launch', async () => {
    await setup('b'.repeat(64))
    await select()
    await press('Start task chat')
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(JSON.stringify(tree?.toJSON())).toContain('plan or execution host changed')
  })
  it('does not launch a task that became active after loading the board', async () => {
    await setup(task.revision, 'active')
    await select()
    await press('Start task chat')
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('does not launch after leaving the task while resume is pending', async () => {
    const client = await setup()
    await select()
    let deliver: ((reply: RpcResponse) => void) | undefined
    client.sendRequest.mockImplementationOnce(
      () =>
        new Promise<RpcResponse>((resolve) => {
          deliver = resolve
        })
    )
    await press('Start task chat')
    await act(async () => {
      tree?.unmount()
      tree = undefined
    })
    await act(async () =>
      deliver?.(
        rpcSuccess({
          revision: task.revision,
          executionHostId: 'runtime:test',
          text: 'Resume',
          workflow: { phase: 'ready', archived: false }
        })
      )
    )
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('does not retry an ambiguous launch', async () => {
    await setup()
    await select()
    mocks.launch.mockResolvedValue({ kind: 'unknown', message: 'Inspect existing session' })
    await press('Start task chat')
    await press('Start task chat')
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
  it('does not query launch choices on unsupported hosts', async () => {
    mocks.supported = false
    const client = await setup()
    await press('Work on task')
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
