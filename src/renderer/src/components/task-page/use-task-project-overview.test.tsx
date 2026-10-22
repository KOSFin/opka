// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ProjectTaskBoard } from '../../../../shared/project-task-board'
import type { TaskProjectScope } from './project-task-projects'
import { readProjectTaskBoard, cachedProjectTaskBoard } from './project-task-client'
import { useTaskProjectOverview } from './use-task-project-overview'

vi.mock('./project-task-client', () => ({
  readProjectTaskBoard: vi.fn(),
  cachedProjectTaskBoard: vi.fn()
}))
const projects: TaskProjectScope[] = [
  {
    key: 'local',
    selector: 'folder:local',
    name: 'Local',
    root: '/local',
    state: 'configured',
    hostLabel: 'Local',
    target: { kind: 'local' }
  },
  {
    key: 'remote',
    selector: 'folder:remote',
    name: 'Remote',
    root: '/remote',
    state: 'configured',
    hostLabel: 'Remote',
    target: { kind: 'environment', environmentId: 'remote' }
  }
]
const board: ProjectTaskBoard = {
  project: { schema: 1, id: 'local', repos: {}, sources: [] },
  executionHostId: 'local',
  total: 0,
  diagnostics: [],
  tasks: []
}
function Probe({
  scopes = projects,
  revision = 0
}: {
  scopes?: TaskProjectScope[]
  revision?: number
}) {
  const overview = useTaskProjectOverview(scopes, '*', revision, 16)
  return (
    <div>
      {overview.views.map((entry) => entry.scope.name).join(',')} ·{' '}
      {overview.loading ? 'Checking' : 'Ready'} · {overview.errors.join(',')}
    </div>
  )
}

it('renders an available board while another host is pending, then reports its error', async () => {
  const remote = Promise.withResolvers<ProjectTaskBoard>()
  vi.mocked(readProjectTaskBoard).mockImplementation((target) =>
    target.kind === 'local' ? Promise.resolve(board) : remote.promise
  )
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<Probe />)
    })
    expect(container.textContent).toContain('Local · Checking')
    expect(readProjectTaskBoard).toHaveBeenCalledTimes(2)
    await act(async () => {
      remote.reject(new Error('connection timeout'))
    })
    expect(container.textContent).toContain('Local · Ready')
    expect(container.textContent).toContain('Reconnect')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
  }
})

it('keeps all five cached project boards while refresh results arrive in batches', async () => {
  const scopes = Array.from({ length: 5 }, (_, index) => ({
    ...projects[0],
    key: `project-${index}`,
    selector: `folder:${index}`,
    name: `Project ${index}`
  }))
  vi.mocked(cachedProjectTaskBoard).mockReturnValue(board)
  const pending = scopes.map(() => Promise.withResolvers<ProjectTaskBoard>())
  vi.mocked(readProjectTaskBoard).mockImplementation((_target, selector) => {
    const index = scopes.findIndex((scope) => scope.selector === selector)
    return pending[index].promise
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Probe scopes={scopes} revision={1} />))
    await act(async () => pending[0].resolve(board))
    for (const scope of scopes) {
      expect(container.textContent).toContain(scope.name)
    }
    await act(async () => pending.forEach((entry) => entry.resolve(board)))
    expect(container.textContent).toContain('Ready')
  } finally {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.mocked(cachedProjectTaskBoard).mockReset()
  }
})
