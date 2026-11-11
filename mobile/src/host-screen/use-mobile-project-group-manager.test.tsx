import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
import {
  useMobileProjectGroupManager,
  type ManagedProjectGroup
} from './use-mobile-project-group-manager'

const target: ManagedProjectGroup = {
  id: 'group',
  hostId: 'local',
  clientHostId: 'host',
  title: 'Group'
}
const group = () => ({
  id: 'group',
  name: 'Group',
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
})
const trees: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
})

async function mount(client: FakeSession, onSaved = vi.fn(), selected = target) {
  let model!: ReturnType<typeof useMobileProjectGroupManager>
  function Probe() {
    model = useMobileProjectGroupManager(client, 'connected', selected, onSaved)
    return null
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(Probe))
  })
  trees.push(tree)
  return {
    state: () => model,
    onSaved,
    rerender: async () => {
      await act(async () => tree.update(createElement(Probe)))
    }
  }
}

describe('mobile project group owner and readback', () => {
  it('confirms rename and icon from the same host catalog before reporting saved', async () => {
    const current = group()
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'projectGroup.list') {
        return rpcSuccess({ groups: [current] })
      }
      if (method === 'projectGroup.update') {
        if (params && typeof params === 'object' && 'updates' in params) {
          Object.assign(current, params.updates)
        }
        return rpcSuccess({ group: current })
      }
      throw new Error(`Unexpected ${method}`)
    })
    const view = await mount(client)
    await act(async () => {
      view.state().setName('Renamed')
      view.state().setIcon({ type: 'lucide', name: 'Rocket' })
    })
    await act(async () => view.state().save())
    expect(client.sendRequest).toHaveBeenCalledWith('projectGroup.update', {
      groupId: 'group',
      updates: { name: 'Renamed', groupIcon: { type: 'lucide', name: 'Rocket' } }
    })
    expect(view.onSaved).toHaveBeenCalledTimes(1)
    expect(view.state().error).toBe('')
  })

  it('never reports saved when an older host ignores the optional icon', async () => {
    const current = group()
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({ groups: [current] })
        : rpcSuccess({ group: current })
    )
    const view = await mount(client)
    await act(async () => view.state().setIcon({ type: 'lucide', name: 'Rocket' }))
    await act(async () => view.state().save())
    expect(view.onSaved).not.toHaveBeenCalled()
    expect(view.state().error).toContain('did not confirm')
  })

  it('explains an older host method refusal without retrying a write', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({ groups: [group()] })
        : {
            id: 'rpc-1',
            ok: false,
            error: { code: 'method_not_found', message: 'Method not found' }
          }
    )
    const view = await mount(client)
    await act(async () => view.state().setName('Renamed'))
    await act(async () => view.state().save())
    expect(view.onSaved).not.toHaveBeenCalled()
    expect(view.state().error).toContain('Update the host')
    expect(
      client.sendRequest.mock.calls.filter(([method]) => method === 'projectGroup.update')
    ).toHaveLength(1)
  })

  it('does not double submit a pending update', async () => {
    const current = group()
    const client = new FakeSession('connected')
    let finish!: (value: ReturnType<typeof rpcSuccess>) => void
    client.sendRequest.mockImplementation((method) =>
      method === 'projectGroup.update'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(rpcSuccess({ groups: [current] }))
    )
    const view = await mount(client)
    await act(async () => view.state().setName('Renamed'))
    let first!: Promise<void>
    await act(async () => {
      first = view.state().save()
      void view.state().save()
    })
    expect(
      client.sendRequest.mock.calls.filter(([method]) => method === 'projectGroup.update')
    ).toHaveLength(1)
    await act(async () => {
      current.name = 'Renamed'
      finish(rpcSuccess({ group: current }))
      await first
    })
    expect(view.onSaved).toHaveBeenCalledTimes(1)
  })

  it('drops an old generation readback without claiming a save', async () => {
    let generation = 0
    const current = group()
    const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
    let finish!: (value: ReturnType<typeof rpcSuccess>) => void
    client.sendRequest.mockImplementation((method) =>
      method === 'projectGroup.update'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(rpcSuccess({ groups: [current] }))
    )
    const view = await mount(client)
    await act(async () => view.state().setName('Old owner'))
    let pending!: Promise<void>
    await act(async () => {
      pending = view.state().save()
    })
    generation += 1
    await view.rerender()
    await act(async () => {
      finish(rpcSuccess({ group: { ...current, name: 'Old owner' } }))
      await pending
    })
    expect(view.onSaved).not.toHaveBeenCalled()
  })

  it('confirms a move and ungroup only after repo.list echoes the same host row', async () => {
    const current = group()
    const repo: {
      id: string
      path: string
      displayName: string
      connectionId: null
      projectGroupId: string | null
      projectGroupOrder: undefined
      badgeColor: undefined
      repoIcon: undefined
      executionHostId: undefined
    } = {
      id: 'repo',
      path: '/project',
      displayName: 'Project',
      connectionId: null,
      projectGroupId: null,
      projectGroupOrder: undefined,
      badgeColor: undefined,
      repoIcon: undefined,
      executionHostId: undefined
    }
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'projectGroup.list') {
        return rpcSuccess({ groups: [current] })
      }
      if (method === 'repo.list') {
        return rpcSuccess({ repos: [repo] })
      }
      if (method === 'projectGroup.moveProject') {
        if (
          params &&
          typeof params === 'object' &&
          'groupId' in params &&
          (typeof params.groupId === 'string' || params.groupId === null)
        ) {
          repo.projectGroupId = params.groupId
        }
        return rpcSuccess({ repo })
      }
      throw new Error(`Unexpected ${method}`)
    })
    const view = await mount(client)
    await act(async () => expect(await view.state().prepareMove()).toBe(true))
    await act(async () => view.state().move(repo, 'group'))
    expect(repo.projectGroupId).toBe('group')
    expect(view.onSaved).toHaveBeenCalledTimes(1)
    await act(async () => view.state().move(repo, null))
    expect(repo.projectGroupId).toBeNull()
    expect(view.onSaved).toHaveBeenCalledTimes(2)
  })

  it('does not claim a move when an old repo catalog omits membership', async () => {
    const current = group()
    const repo = {
      id: 'repo',
      path: '/project',
      displayName: 'Project',
      connectionId: null,
      projectGroupId: undefined,
      projectGroupOrder: undefined,
      badgeColor: undefined,
      repoIcon: undefined,
      executionHostId: undefined
    }
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) => {
      if (method === 'projectGroup.list') {
        return rpcSuccess({ groups: [current] })
      }
      if (method === 'repo.list') {
        return rpcSuccess({ repos: [repo] })
      }
      return rpcSuccess({ repo })
    })
    const view = await mount(client)
    await act(async () => expect(await view.state().prepareMove()).toBe(true))
    await act(async () => view.state().move(repo, 'group'))
    expect(view.onSaved).not.toHaveBeenCalled()
    expect(view.state().error).toContain('did not confirm')
  })

  it('refuses a foreign group or deleted destination without sending a write', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(
      rpcSuccess({ groups: [{ ...group(), executionHostId: 'runtime:other' }] })
    )
    const view = await mount(client)
    expect(view.state().group).toBeNull()
    expect(view.state().error).toContain('another host')
    await act(async () => view.state().save())
    expect(client.sendRequest.mock.calls.some(([method]) => method === 'projectGroup.update')).toBe(
      false
    )
  })

  it('refuses a destination on another execution host before sending a move', async () => {
    const client = new FakeSession('connected')
    const repo = {
      id: 'repo',
      path: '/project',
      displayName: 'Project',
      connectionId: null,
      projectGroupId: undefined,
      projectGroupOrder: undefined,
      badgeColor: undefined,
      repoIcon: undefined,
      executionHostId: undefined
    }
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({
            groups: [group(), { ...group(), id: 'remote', executionHostId: 'runtime:other' }]
          })
        : rpcSuccess({ repos: [repo] })
    )
    const view = await mount(client)
    await act(async () => expect(await view.state().prepareMove()).toBe(true))
    await act(async () => view.state().move(repo, 'remote'))
    expect(view.state().error).toContain('another host')
    expect(
      client.sendRequest.mock.calls.some(([method]) => method === 'projectGroup.moveProject')
    ).toBe(false)
  })

  it('does not offer an SSH repo whose old host omits its connection selector', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({ groups: [{ ...group(), connectionId: 'ssh-1' }] })
        : rpcSuccess({
            repos: [
              {
                id: 'same',
                path: '/remote/app',
                displayName: 'Remote',
                executionHostId: 'ssh:ssh-1'
              }
            ]
          })
    )
    const view = await mount(client, vi.fn(), { ...target, hostId: 'ssh:ssh-1' })
    await act(async () => expect(await view.state().prepareMove()).toBe(false))
    expect(view.state().repos).toEqual([])
    expect(view.state().error).toContain('verified host selector')
    expect(
      client.sendRequest.mock.calls.some(([method]) => method === 'projectGroup.moveProject')
    ).toBe(false)
  })

  it('does not offer a different execution host repo from this group settings sheet', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({ groups: [group()] })
        : rpcSuccess({
            repos: [
              {
                id: 'foreign-repo',
                path: '/foreign',
                displayName: 'Foreign repo',
                executionHostId: 'runtime:other',
                connectionId: null
              }
            ]
          })
    )
    const view = await mount(client)
    await act(async () => expect(await view.state().prepareMove()).toBe(false))
    expect(view.state().repos).toEqual([])
    expect(
      client.sendRequest.mock.calls.some(([method]) => method === 'projectGroup.moveProject')
    ).toBe(false)
  })

  it('refuses a direct foreign-repo move callback from this group settings sheet', async () => {
    const foreignRepo = {
      id: 'foreign-repo',
      path: '/foreign',
      displayName: 'Foreign repo',
      executionHostId: 'runtime:other',
      connectionId: null,
      projectGroupId: 'foreign-group',
      projectGroupOrder: undefined,
      badgeColor: undefined,
      repoIcon: undefined
    }
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementation(async (method) =>
      method === 'projectGroup.list'
        ? rpcSuccess({ groups: [group()] })
        : method === 'repo.list'
          ? rpcSuccess({ repos: [foreignRepo] })
          : rpcSuccess({ repo: foreignRepo })
    )
    const view = await mount(client)
    await act(async () => view.state().move(foreignRepo, null))
    expect(
      client.sendRequest.mock.calls.some(([method]) => method === 'projectGroup.moveProject')
    ).toBe(false)
    expect(view.onSaved).not.toHaveBeenCalled()
  })
})
