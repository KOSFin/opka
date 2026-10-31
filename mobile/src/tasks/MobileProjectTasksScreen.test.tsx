import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
const state = vi.hoisted<{
  client: FakeSession | null
  connection: string
  push: ReturnType<typeof vi.fn>
}>(() => ({
  client: null,
  connection: 'connected',
  push: vi.fn()
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  StyleSheet: { create: (v: unknown) => v }
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  RefreshCw: 'RefreshCw'
}))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ hostId: 'host-1' }) }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: state.client, state: state.connection })
}))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: state.push, back: vi.fn() })
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: () => null }))
vi.mock('../components/MobileMarkdown', () => ({
  MobileMarkdown: ({ content }: { content: string }) => createElement('Markdown', {}, content)
}))
import { MobileProjectTasksScreen } from './MobileProjectTasksScreen'
import { ProjectTaskBoard } from './ProjectTaskLists'
import type { MobileProjectTask } from './project-task-rpc'
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  state.connection = 'connected'
  vi.clearAllMocks()
})
function text() {
  return JSON.stringify(tree?.toJSON())
}
async function press(label: string) {
  const button = tree?.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find(
      (node) =>
        node.props.accessibilityLabel === label ||
        JSON.stringify(
          node.findAll((node) => String(node.type) === 'Text').map((t) => t.props.children)
        ).includes(label)
    )
  if (!button) {
    throw new Error(`Missing button ${label}`)
  }
  await act(async () => button.props.onPress())
}
describe('mobile project task journey', () => {
  it('opens a project, task, saved report and sends a fenced review decision', async () => {
    state.client = new FakeSession('connected')
    state.client.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'projectTask.catalog') {
        return rpcSuccess({
          projects: [{ selector: 'folder:/test', name: 'Test project', state: 'configured' }],
          truncated: false
        })
      }
      if (method === 'projectTask.board') {
        return rpcSuccess({
          project: { id: 'p1' },
          executionHostId: 'runtime:test',
          total: 1,
          tasks: [
            {
              id: 't1',
              title: 'Test task',
              revision: 'a'.repeat(64),
              path: 'docs/task.md',
              workflow: {
                phase: 'review',
                archived: false,
                revisionChanged: false,
                attempts: [],
                events: []
              }
            }
          ]
        })
      }
      if (method === 'projectTask.show') {
        return rpcSuccess({ id: 't1', revision: 'a'.repeat(64), body: 'Implement the plan' })
      }
      if (method === 'projectTask.documents') {
        return rpcSuccess({
          paths: ['reports/result.md'],
          ...(typeof params === 'object' && params !== null && 'path' in params
            ? { path: 'reports/result.md', content: 'Checks passed' }
            : {})
        })
      }
      return rpcSuccess({})
    })
    await act(async () => {
      tree = create(createElement(MobileProjectTasksScreen))
    })
    await press('Test project')
    expect(text()).toContain('Review')
    expect(text()).toContain('Project board')
    await press('Test task')
    expect(text()).toContain('Implement the plan')
    expect(text()).toContain('Overview')
    expect(text()).toContain('Reports (1)')
    expect(text()).not.toContain('result.md')
    await press('Reports (1)')
    await press('result.md')
    expect(text()).toContain('Checks passed')
    await press('Refresh project tasks')
    expect(text()).toContain('Checks passed')
    await press('Back')
    expect(text()).toContain('result.md')
    await press('Overview')
    await act(async () =>
      tree?.root
        .find((node) => String(node.type) === 'TextInput')
        .props.onChangeText('Reviewed the report')
    )
    await press('Accept result')
    expect(state.client.sendRequest).toHaveBeenCalledWith('projectTask.decide', {
      worktree: 'folder:/test',
      id: 't1',
      revision: 'a'.repeat(64),
      expectedExecutionHostId: 'runtime:test',
      action: 'accept',
      reason: 'Reviewed the report'
    })
  })
  it('names loss of contact without declaring agent exit', async () => {
    state.connection = 'disconnected'
    state.client = new FakeSession('disconnected')
    await act(async () => {
      tree = create(createElement(MobileProjectTasksScreen))
    })
    expect(text()).toContain('execution is unverifiable')
    expect(state.client.sendRequest).not.toHaveBeenCalled()
  })
})

it('separates board stages and archived tasks without changing task identity', async () => {
  const onSelect = vi.fn()
  const makeTask = (id: string, phase: string, archived = false): MobileProjectTask => ({
    id,
    title: id,
    revision: 'a'.repeat(64),
    path: `docs/${id}.md`,
    workflow: { phase, archived, revisionChanged: false, attempts: [], events: [] }
  })
  const active = makeTask('Active task', 'active')
  await act(async () => {
    tree = create(
      createElement(ProjectTaskBoard, {
        tasks: [makeTask('Old task', 'active', true), active, makeTask('Planned task', 'ready')],
        loading: false,
        onSelect
      })
    )
  })
  const rendered = text()
  expect(rendered).toContain('Planned')
  expect(rendered).toContain('In progress')
  expect(rendered).toContain('Archived')
  expect(rendered.indexOf('Planned')).toBeLessThan(rendered.indexOf('In progress'))
  await press('Active task')
  expect(onSelect).toHaveBeenCalledWith(active)
})
