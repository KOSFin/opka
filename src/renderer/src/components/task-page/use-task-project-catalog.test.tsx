// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ProjectTaskCatalog } from '../../../../shared/project-task-catalog'
import { useTaskProjectCatalog } from './use-task-project-catalog'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      folderWorkspaces: [],
      repos: []
    }))
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.clearAllMocks()
})

const environment: PublicKnownRuntimeEnvironment = {
  id: 'remote',
  name: 'Remote',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'ws', kind: 'websocket', label: 'WS', endpoint: 'ws://localhost' }],
  preferredEndpointId: 'ws'
}
const local: ProjectTaskCatalog = {
  truncated: false,
  projects: [
    { selector: 'folder:local', name: 'Local project', root: '/local', state: 'configured' }
  ]
}
function Probe() {
  const catalog = useTaskProjectCatalog()
  return (
    <div>
      <span>{catalog.projects.map((project) => project.name).join(',')}</span>
      <span>{catalog.loading ? 'Checking' : 'Ready'}</span>
      <span>{catalog.errors.join(',')}</span>
      <button onClick={catalog.refresh}>Refresh</button>
    </div>
  )
}

it('shows local projects before a slow remote and ignores reference-only catalog churn', async () => {
  const remote = Promise.withResolvers<ProjectTaskCatalog>()
  vi.mocked(callRuntimeRpc).mockImplementation((target) =>
    target.kind === 'local' ? Promise.resolve(local) : remote.promise
  )
  useAppStore.setState({ runtimeEnvironments: [environment], folderWorkspaces: [], repos: [] })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
  expect(container.textContent).toContain('Local project')
  expect(container.textContent).toContain('Checking')
  expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  await act(async () => {
    useAppStore.setState({
      runtimeEnvironments: [{ ...environment, updatedAt: 2 }],
      folderWorkspaces: [],
      repos: []
    })
  })
  expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  await act(async () => {
    remote.resolve({
      truncated: false,
      projects: [
        { selector: 'folder:remote', name: 'Remote project', root: '/remote', state: 'configured' }
      ]
    })
  })
  expect(container.textContent).toContain('Local project,Remote project')
  expect(container.textContent).toContain('Ready')
  await act(async () => {
    container.querySelector('button')?.click()
  })
  expect(callRuntimeRpc).toHaveBeenCalledTimes(4)
})

it('reloads after a host contact edge without reacting to status timestamp churn', async () => {
  vi.mocked(callRuntimeRpc).mockImplementation((target) =>
    target.kind === 'local'
      ? Promise.resolve(local)
      : Promise.reject(new Error('Disconnected'))
  )
  useAppStore.setState({
    runtimeEnvironments: [environment],
    runtimeStatusByEnvironmentId: new Map([
      ['remote', { status: null, checkedAt: 1, hostContactEpoch: 0 }]
    ]),
    folderWorkspaces: [],
    repos: []
  })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<Probe />))
  expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  await act(async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        ['remote', { status: null, checkedAt: 2, hostContactEpoch: 0 }]
      ])
    })
  })
  expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  vi.mocked(callRuntimeRpc).mockResolvedValue(local)
  await act(async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        ['remote', { status: null, checkedAt: 3, hostContactEpoch: 1 }]
      ])
    })
  })
  expect(callRuntimeRpc).toHaveBeenCalledTimes(4)
  expect(container.textContent).not.toContain('Disconnected')
})
