import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
const state = vi.hoisted<{
  client: FakeSession | null
  connection: string
  push: ReturnType<typeof vi.fn>
  scrollTo: ReturnType<typeof vi.fn>
}>(() => ({
  client: null,
  connection: 'connected',
  push: vi.fn(),
  scrollTo: vi.fn()
}))
vi.mock('../components/MobileSectionReveal', () => ({
  MobileSectionReveal: ({ children }: { children: import('react').ReactNode }) => children
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: React.forwardRef((props: { children: import('react').ReactNode }, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollTo: state.scrollTo }))
      return React.createElement('ScrollView', props, props.children)
    }),
    TextInput: 'TextInput',
    StyleSheet: { create: (v: unknown) => v }
  }
})
vi.mock('lucide-react-native', () => ({
  Circle: 'Circle',
  CircleCheck: 'CircleCheck',
  CirclePlay: 'CirclePlay',
  ClipboardCheck: 'ClipboardCheck',
  TriangleAlert: 'TriangleAlert',
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
vi.mock('../components/PickerModal', async () => {
  const React = await import('react')
  return {
    PickerModal: ({
      visible,
      options,
      onSelect
    }: {
      visible: boolean
      options: { value: string; label: string }[]
      onSelect: (value: string) => void
    }) =>
      visible
        ? React.createElement(
            'PickerModal',
            {},
            options.map((option) =>
              React.createElement(
                'Pressable',
                {
                  key: option.value,
                  accessibilityLabel: option.label,
                  onPress: () => onSelect(option.value)
                },
                React.createElement('Text', {}, option.label)
              )
            )
          )
        : null
  }
})
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
  it.each(['', 'Reviewed the report'])('accepts a report with comment %j', async (comment) => {
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
      tree?.root.find((node) => String(node.type) === 'TextInput').props.onChangeText(comment)
    )
    await press('Accept result')
    expect(state.client.sendRequest).toHaveBeenCalledWith('projectTask.decide', {
      worktree: 'folder:/test',
      id: 't1',
      revision: 'a'.repeat(64),
      expectedExecutionHostId: 'runtime:test',
      action: 'accept',
      reason: comment || 'Operator accepted the reviewed result.'
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
  it('opens working copies beside project tasks on the same host route', async () => {
    state.connection = 'disconnected'
    state.client = new FakeSession('disconnected')
    await act(async () => {
      tree = create(createElement(MobileProjectTasksScreen))
    })
    await press('Working copies')
    expect(state.push).toHaveBeenCalledWith('/h/host-1')
  })
  it('restores catalog scroll after opening and leaving a board', async () => {
    state.client = new FakeSession('connected')
    state.client.sendRequest.mockImplementation(async (method) =>
      method === 'projectTask.catalog'
        ? rpcSuccess({
            projects: [{ selector: 'folder:/test', name: 'Test project', state: 'configured' }],
            truncated: false
          })
        : rpcSuccess({ project: { id: 'p' }, executionHostId: 'runtime:test', total: 0, tasks: [] })
    )
    await act(async () => {
      tree = create(createElement(MobileProjectTasksScreen))
    })
    const scroller = tree?.root.find((node) => String(node.type) === 'ScrollView')
    expect(scroller).toBeDefined()
    await act(async () =>
      scroller?.props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: 72 } } })
    )
    await press('Test project')
    await press('Back')
    expect(state.scrollTo).toHaveBeenCalledWith({ y: 72, animated: false })
  })
  it('keeps same-id tasks scoped to their selected project and filters by source', async () => {
    state.client = new FakeSession('connected')
    state.client.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'projectTask.catalog') {
        return rpcSuccess({
          projects: [
            { selector: 'folder:/one', name: 'One', state: 'configured' },
            { selector: 'folder:/two', name: 'Two', state: 'configured' }
          ],
          truncated: false
        })
      }
      if (method === 'projectTask.board') {
        const worktree =
          params && typeof params === 'object' && 'worktree' in params ? params.worktree : ''
        return rpcSuccess({
          project: { id: worktree },
          executionHostId: 'runtime:test',
          total: 1,
          tasks: [
            {
              id: 'same',
              title: worktree === 'folder:/one' ? 'First task' : 'Second task',
              source: worktree === 'folder:/one' ? 'alpha' : 'beta',
              revision: 'a'.repeat(64),
              path: 'task.md',
              workflow: {
                phase: 'ready',
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
        return rpcSuccess({ id: 'same', revision: 'a'.repeat(64), body: 'Second project body' })
      }
      if (method === 'projectTask.documents') {
        return rpcSuccess({ paths: [] })
      }
      return rpcSuccess({})
    })
    await act(async () => {
      tree = create(createElement(MobileProjectTasksScreen))
    })
    expect(text()).toContain('First task')
    expect(text()).toContain('Second task')
    await press('Include One')
    expect(text()).not.toContain('First task')
    expect(text()).toContain('Second task')
    await press('Filter task source')
    await press('beta')
    expect(text()).toContain('Second task')
    expect(text()).not.toContain('First task')
    await press('Second task')
    expect(text()).toContain('Second project body')
    expect(state.client.sendRequest).toHaveBeenCalledWith(
      'projectTask.show',
      { worktree: 'folder:/two', id: 'same' },
      expect.objectContaining({ failWhenDisconnected: true })
    )
  })

  it('toggles a project with two repositories in one selection update while keeping member controls', async () => {
    state.client = new FakeSession('connected')
    state.client.sendRequest.mockImplementation(async (method) =>
      method === 'projectTask.catalog'
        ? rpcSuccess({
            projects: [
              {
                selector: 'folder:/web',
                name: 'web',
                state: 'configured',
                groupId: 'studio',
                groupName: 'Studio',
                repositoryName: 'web',
                projectGroupsAvailable: true
              },
              {
                selector: 'folder:/cli',
                name: 'cli',
                state: 'configured',
                groupId: 'studio',
                groupName: 'Studio',
                repositoryName: 'cli',
                projectGroupsAvailable: true
              },
              {
                selector: 'folder:/docs',
                name: 'Docs',
                state: 'configured',
                projectGroupsAvailable: true
              }
            ],
            truncated: false
          })
        : rpcSuccess({ project: { id: 'p' }, executionHostId: 'local', total: 0, tasks: [] })
    )
    await act(async () => {
      tree = create(createElement(MobileProjectTasksScreen))
    })
    const checked = (label: string) =>
      tree?.root.findByProps({ accessibilityLabel: label }).props.accessibilityState.checked
    expect(checked('Include project Studio')).toBe(true)
    await press('Include project Studio')
    expect(checked('Include Studio / web')).toBe(false)
    expect(checked('Include Studio / cli')).toBe(false)
    expect(checked('Include Docs')).toBe(true)
    await press('Include project Studio')
    expect(checked('Include Studio / web')).toBe(true)
    expect(checked('Include Studio / cli')).toBe(true)
    await press('Include Studio / web')
    expect(checked('Include project Studio')).toBe('mixed')
    expect(checked('Include Studio / cli')).toBe(true)
    expect(text()).toContain('▣')
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
  const blocked: MobileProjectTask = {
    ...makeTask('Blocked task', 'active'),
    workflow: {
      ...makeTask('Blocked task', 'active').workflow,
      attempts: [
        {
          id: 'attempt',
          nativeStatus: 'blocked',
          terminal: null,
          session: { blocker: 'Needs review scope', reportPath: null }
        }
      ]
    }
  }
  await act(async () => {
    tree = create(
      createElement(ProjectTaskBoard, {
        tasks: [
          makeTask('Old task', 'active', true),
          active,
          blocked,
          makeTask('Planned task', 'ready')
        ],
        loading: false,
        onSelect
      })
    )
  })
  const rendered = text()
  expect(rendered).toContain('Planned')
  expect(rendered).toContain('In progress')
  expect(rendered).toContain('Archived')
  const labels = tree?.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children)
    )
  expect(labels).toContain('Waiting: Needs review scope')
  expect(labels).toContain('Next: Review the blocker and provide the missing decision')
  expect(rendered.indexOf('Planned')).toBeLessThan(rendered.indexOf('In progress'))
  await press('Active task')
  expect(onSelect).toHaveBeenCalledWith(active)
})
