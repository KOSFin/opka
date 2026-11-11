import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
import { useMobileProjectGroupManager } from './use-mobile-project-group-manager'

const group = () => ({
  id: 'group',
  name: 'Runtime project',
  parentPath: '/runtime',
  connectionId: 'nested-ssh',
  executionHostId: 'runtime:env-1',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  groupIcon: null,
  createdAt: 1,
  updatedAt: 1
})

const trees: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
})

async function mount(client: FakeSession, onSaved = vi.fn()) {
  let model!: ReturnType<typeof useMobileProjectGroupManager>
  function Probe() {
    model = useMobileProjectGroupManager(
      client,
      'connected',
      { id: 'group', hostId: 'runtime:env-1', clientHostId: 'host', title: 'Runtime project' },
      onSaved
    )
    return null
  }
  await act(async () => {
    trees.push(create(createElement(Probe)))
  })
  return { state: () => model, onSaved }
}

it('keeps a runtime-owned repo with its nested SSH selector movable on the same runtime host', async () => {
  let membership: string | null = null
  const repo = {
    id: 'runtime-repo',
    path: '/runtime',
    displayName: 'Runtime repo',
    executionHostId: 'runtime:env-1',
    connectionId: 'nested-ssh',
    projectGroupId: membership,
    projectGroupOrder: undefined,
    badgeColor: undefined,
    repoIcon: undefined
  }
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method, params) => {
    if (method === 'projectGroup.list') {
      return rpcSuccess({ groups: [group()] })
    }
    if (method === 'repo.list') {
      return rpcSuccess({ repos: [{ ...repo, projectGroupId: membership }] })
    }
    if (method === 'projectGroup.moveProject') {
      expect(params).toMatchObject({ connectionId: 'nested-ssh', groupId: 'group' })
      membership = 'group'
      return rpcSuccess({ repo: { ...repo, projectGroupId: membership } })
    }
    throw new Error(`Unexpected ${method}`)
  })
  const view = await mount(client)
  await act(async () => expect(await view.state().prepareMove()).toBe(true))
  await act(async () => view.state().move(repo, 'group'))
  expect(view.onSaved).toHaveBeenCalledTimes(1)
})

it('refuses a direct same-host row absent from the fresh offered catalog', async () => {
  const offered = {
    id: 'offered',
    path: '/offered',
    displayName: 'Offered',
    executionHostId: 'runtime:env-1',
    connectionId: 'nested-ssh',
    projectGroupId: null,
    projectGroupOrder: undefined,
    badgeColor: undefined,
    repoIcon: undefined
  }
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method) =>
    method === 'projectGroup.list'
      ? rpcSuccess({ groups: [group()] })
      : rpcSuccess({ repos: [offered] })
  )
  const view = await mount(client)
  await act(async () => expect(await view.state().prepareMove()).toBe(true))
  await act(async () => view.state().move({ ...offered, id: 'not-offered', path: '/other' }, null))
  expect(
    client.sendRequest.mock.calls.some(([method]) => method === 'projectGroup.moveProject')
  ).toBe(false)
})
