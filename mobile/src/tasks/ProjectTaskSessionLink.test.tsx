import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
const mocks = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (v: unknown) => v }
}))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => ({ push: mocks.push }) }))
import { ProjectTaskSessionLink } from './ProjectTaskSessionLink'
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.clearAllMocks()
})
async function open(client: FakeSession, terminal: string) {
  await act(async () => {
    tree = create(
      createElement(ProjectTaskSessionLink, {
        client,
        connected: true,
        hostId: 'h1',
        terminal
      })
    )
  })
  await act(async () =>
    tree?.root.find((node) => String(node.type) === 'Pressable').props.onPress()
  )
}
it('opens an exact PTY pane from host inventory', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(
    rpcSuccess({
      terminals: [{ handle: 'term_one', worktreeId: 'folder:test', tabId: 'tab', leafId: 'leaf' }]
    })
  )
  await open(client, 'term_one')
  expect(mocks.push).toHaveBeenCalledWith('/h/h1/session/folder%3Atest?paneKey=tab%3Aleaf')
})
it('activates the exact structured chat without treating it as a PTY', async () => {
  const client = new FakeSession('connected')
  client.sendRequest
    .mockResolvedValueOnce(
      rpcSuccess({
        snapshots: [
          {
            worktree: 'folder:child',
            tabs: [{ type: 'agent-session', id: 'tab-1', sessionId: 'codex_12345678' }]
          }
        ]
      })
    )
    .mockResolvedValueOnce(rpcSuccess({}))
  await open(client, 'orca_session_id:codex_12345678')
  expect(client.sendRequest).toHaveBeenCalledWith('session.tabs.activate', {
    worktree: 'folder:child',
    tabId: 'tab-1',
    navigation: 'caller',
    notifyClients: false
  })
  expect(mocks.push).toHaveBeenCalledWith('/h/h1/session/folder%3Achild')
})
it('keeps missing sessions unverifiable and does not navigate', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess({ terminals: [] }))
  await open(client, 'term_gone')
  expect(mocks.push).not.toHaveBeenCalled()
  expect(JSON.stringify(tree?.toJSON())).toContain('saved reports remain available')
})
