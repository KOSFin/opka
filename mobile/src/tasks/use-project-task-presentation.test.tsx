import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
import { useProjectTaskPresentation } from './use-project-task-presentation'
import type { MobileProjectTask } from './project-task-rpc'
const task: MobileProjectTask = {
  id: 'task-1',
  title: 'Fix thing',
  path: '/task.md',
  revision: 'a'.repeat(64),
  workflow: { phase: 'review', archived: false, revisionChanged: false, attempts: [], events: [] }
}
function transport() {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method, params) => {
    if (method === 'projectTask.catalog') {
      return rpcSuccess({
        projects: [{ selector: 'folder:/test', name: 'Test', state: 'configured' }],
        truncated: false
      })
    }
    if (method === 'projectTask.board') {
      return rpcSuccess({
        project: { id: 'p', sources: [{ id: 'tasks', path: '/tasks' }] },
        executionHostId: 'runtime:test',
        total: 1,
        tasks: [task]
      })
    }
    if (method === 'projectTask.show') {
      return rpcSuccess({ id: task.id, revision: task.revision, body: 'Body', content: 'Content' })
    }
    if (method === 'projectTask.documents') {
      return rpcSuccess({
        paths: ['report.md'],
        ...(params && typeof params === 'object' && 'path' in params ? { content: 'Report' } : {})
      })
    }
    throw new Error(`Unexpected ${method}`)
  })
  return client
}
const trees: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
})
async function mount(client: FakeSession, hostId = 'host') {
  let model!: ReturnType<typeof useProjectTaskPresentation>
  function Probe() {
    model = useProjectTaskPresentation(client, 'connected', hostId)
    return null
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(Probe))
  })
  trees.push(tree)
  return {
    state: () => model,
    tree,
    rerender: async () => {
      await act(async () => tree.update(createElement(Probe)))
    }
  }
}
describe('retained project task navigation', () => {
  it('restores project, task, report and filters without reloading fresh results', async () => {
    const client = transport()
    const first = await mount(client)
    await act(async () => first.state().setProject('folder:/test'))
    await act(async () => first.state().setQuery('Fix'))
    await act(async () => first.state().setPhase('review'))
    await act(async () => first.state().setSource('tasks'))
    await act(async () => first.state().setProjects(['folder:/test']))
    await act(async () => first.state().setScroll('catalogScroll', 84))
    await act(async () => first.state().setTask(task))
    await act(async () => first.state().setScroll('boardScroll', 128))
    await act(async () => first.state().setDocument('report.md'))
    expect(first.state()).toMatchObject({ content: 'Content', report: 'Report', verified: true })
    await act(async () => first.tree.unmount())
    trees.splice(trees.indexOf(first.tree), 1)
    client.sendRequest.mockClear()
    const second = await mount(client)
    expect(second.state()).toMatchObject({
      project: 'folder:/test',
      document: 'report.md',
      content: 'Content',
      report: 'Report',
      verified: true,
      selection: {
        query: 'Fix',
        phase: 'review',
        source: 'tasks',
        projects: ['folder:/test'],
        catalogScroll: 84,
        boardScroll: 128
      }
    })
    expect(second.state().task?.id).toBe(task.id)
    expect(client.sendRequest).not.toHaveBeenCalled()
    await act(async () => second.state().refreshTasks())
    expect(client.sendRequest.mock.calls.some(([method]) => method === 'projectTask.board')).toBe(
      true
    )
    expect(client.sendRequest.mock.calls.some(([method]) => method === 'projectTask.show')).toBe(
      true
    )
  })
  it('isolates another client and a same-client authority generation', async () => {
    let generation = 0
    const client = Object.assign(transport(), { getGeneration: () => generation })
    const first = await mount(client)
    await act(async () => first.state().setProject('folder:/test'))
    await act(async () => first.state().setTask(task))
    const oldSelect = first.state().setQuery
    generation += 1
    await first.rerender()
    await act(async () => oldSelect('Old owner query'))
    expect(first.state()).toMatchObject({ project: null, task: null, selection: { query: '' } })
    const other = await mount(transport())
    expect(other.state()).toMatchObject({ project: null, task: null })
  })
  it('ignores a previous generation board reply', async () => {
    let generation = 0
    const client = Object.assign(transport(), { getGeneration: () => generation })
    const original = client.sendRequest.getMockImplementation()!
    let finish!: (value: ReturnType<typeof rpcSuccess>) => void
    client.sendRequest.mockImplementation((method, params) =>
      method === 'projectTask.board'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : original(method, params)
    )
    const fixture = await mount(client)
    await act(async () => fixture.state().setProject('folder:/test'))
    generation += 1
    await fixture.rerender()
    await act(async () =>
      finish(
        rpcSuccess({
          project: { id: 'p' },
          executionHostId: 'runtime:old',
          total: 1,
          tasks: [task]
        })
      )
    )
    expect(fixture.state()).toMatchObject({
      project: null,
      tasks: [],
      content: '',
      executionHostId: ''
    })
  })
  it('drops a late multi-project overview when the host owner generation changes', async () => {
    let generation = 0
    const client = Object.assign(transport(), { getGeneration: () => generation })
    const original = client.sendRequest.getMockImplementation()!
    let finish!: (value: ReturnType<typeof rpcSuccess>) => void
    client.sendRequest.mockImplementation((method, params) =>
      method === 'projectTask.board'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : original(method, params)
    )
    const fixture = await mount(client)
    expect(client.sendRequest.mock.calls.some(([method]) => method === 'projectTask.board')).toBe(
      true
    )
    const finishOld = finish
    generation += 1
    await fixture.rerender()
    await act(async () =>
      finishOld(
        rpcSuccess({
          project: { id: 'old' },
          executionHostId: 'runtime:old',
          total: 1,
          tasks: [task]
        })
      )
    )
    expect(fixture.state().overview.rows).toEqual([])
    expect(fixture.state().selection.projects).toEqual(['*'])
  })
})

it('never exposes a previous task body under a newly refreshed revision', async () => {
  const client = transport()
  const fixture = await mount(client)
  await act(async () => fixture.state().setProject('folder:/test'))
  await act(async () => fixture.state().setTask(task))
  expect(fixture.state().content).toBe('Content')
  const next = { ...task, revision: 'b'.repeat(64) }
  const original = client.sendRequest.getMockImplementation()!
  let finish!: (value: ReturnType<typeof rpcSuccess>) => void
  client.sendRequest.mockImplementation((method, params) => {
    if (method === 'projectTask.board') {
      return Promise.resolve(
        rpcSuccess({
          project: { id: 'p' },
          executionHostId: 'runtime:test',
          total: 1,
          tasks: [next]
        })
      )
    }
    if (method === 'projectTask.show') {
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    return original(method, params)
  })
  await act(async () => fixture.state().refreshTasks())
  expect(fixture.state().task?.revision).toBe(next.revision)
  expect(fixture.state().content).toBe('')
  expect(fixture.state().verified).toBe(false)
  await act(async () =>
    finish(
      rpcSuccess({ id: next.id, revision: next.revision, body: 'New body', content: 'New content' })
    )
  )
  expect(fixture.state()).toMatchObject({ content: 'New content', verified: true })
})
