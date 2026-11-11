import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
import { useMobileProjectGroupManager } from './use-mobile-project-group-manager'

const target = { id: 'group', hostId: 'local', clientHostId: 'host', title: 'Project' }
const group = {
  id: 'group',
  name: 'Project',
  parentPath: '/project',
  connectionId: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  groupIcon: null,
  createdAt: 1,
  updatedAt: 1
}
const contradictoryRepo = {
  id: 'repo',
  path: '/remote/project',
  displayName: 'Remote repo',
  executionHostId: 'local',
  connectionId: 'ssh-1',
  projectGroupId: 'group',
  projectGroupOrder: undefined,
  badgeColor: undefined,
  repoIcon: undefined
}

const trees: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
})

async function mount(client: FakeSession) {
  const onSaved = vi.fn()
  let model!: ReturnType<typeof useMobileProjectGroupManager>
  function Probe() {
    model = useMobileProjectGroupManager(client, 'connected', target, onSaved)
    return null
  }
  await act(async () => {
    trees.push(create(createElement(Probe)))
  })
  return { state: () => model, onSaved }
}

describe('project settings host selector and copy', () => {
  it('does not offer a local-claimed repo carrying an SSH selector', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({ groups: [group] })
        : method === 'repo.list'
          ? rpcSuccess({ repos: [contradictoryRepo] })
          : rpcSuccess({ repo: contradictoryRepo })
    )
    const view = await mount(client)
    await act(async () => expect(await view.state().prepareMove()).toBe(false))
    expect(view.state().repos).toEqual([])
  })

  it('refuses a direct move of a local-claimed repo carrying an SSH selector', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({ groups: [group] })
        : rpcSuccess({ repo: contradictoryRepo })
    )
    const view = await mount(client)
    await act(async () => view.state().move(contradictoryRepo, null))
    expect(
      client.sendRequest.mock.calls.some(([method]) => method === 'projectGroup.moveProject')
    ).toBe(false)
    expect(view.onSaved).not.toHaveBeenCalled()
  })

  it('uses Project wording after an unclassified save failure', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) => {
      if (method === 'projectGroup.list') {
        return rpcSuccess({ groups: [group] })
      }
      const failure = new Error('Synthetic transient failure')
      failure.message = ''
      throw failure
    })
    const view = await mount(client)
    await act(async () => view.state().setName('Renamed'))
    await act(async () => view.state().save())
    expect(view.state().error).toBe('Project change unverified. Refresh before retrying.')
    expect(view.onSaved).not.toHaveBeenCalled()
  })
})
