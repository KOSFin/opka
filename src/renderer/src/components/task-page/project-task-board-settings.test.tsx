// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectTaskAgentSettings } from '../../../../shared/project-task-agent-settings'
import { ProjectTaskBoardSettings } from './ProjectTaskBoardSettings'
import { projectTaskCall, type ProjectTaskClient } from './project-task-client'
import type { TaskProjectScope } from './project-task-projects'

vi.mock('./project-task-client', () => ({ projectTaskCall: vi.fn() }))
const project: TaskProjectScope = {
  key: 'local-fixture',
  selector: 'folder:fixture',
  root: '/synthetic',
  name: 'Website',
  hostLabel: 'This computer',
  target: { kind: 'local' },
  state: 'configured'
}
const client: ProjectTaskClient = {
  target: project.target,
  worktree: project.selector,
  executionHostId: 'local'
}
const enabled: ProjectTaskAgentSettings = {
  enabled: true,
  state: 'enabled',
  files: [{ path: '.agents/skills/opka-tasks/SKILL.md', state: 'installed' }]
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const mount = (
  selected: TaskProjectScope | undefined = project,
  target: ProjectTaskClient | null = client
) =>
  render(
    <ProjectTaskBoardSettings
      client={target}
      project={selected}
      projects={[project]}
      onChoose={vi.fn()}
    />
  )

it('reconciles by default without opening a card or approval dialog, then shows real state in board settings', async () => {
  vi.mocked(projectTaskCall).mockResolvedValue(enabled)
  mount()
  await waitFor(() =>
    expect(projectTaskCall).toHaveBeenCalledWith(client, 'agentSettings', { action: 'reconcile' })
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Board settings' }))
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  expect(screen.getByRole('status').textContent).toBe('Enabled')
  expect(screen.queryByText('Enable agent task workflow')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'Board settings' }))
  expect(screen.getByRole('status').textContent).toBe('Enabled')
  expect(projectTaskCall).toHaveBeenCalledTimes(1)
})

it('disables and reenables the project without repeating confirmation windows', async () => {
  vi.mocked(projectTaskCall)
    .mockResolvedValueOnce(enabled)
    .mockResolvedValueOnce({
      enabled: false,
      state: 'disabled',
      files: []
    })
    .mockResolvedValueOnce(enabled)
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Board settings' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Enabled'))
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Disabled'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(projectTaskCall).toHaveBeenLastCalledWith(client, 'agentSettings', { action: 'disable' })
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Enabled'))
  expect(projectTaskCall).toHaveBeenLastCalledWith(client, 'agentSettings', { action: 'enable' })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
})

it('keeps custom integration read-only and exposes actionable errors from an older host', async () => {
  vi.mocked(projectTaskCall).mockResolvedValue({ ...enabled, state: 'customized' })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Board settings' }))
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('Custom instructions detected')
  )
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/custom skill files are preserved/)).toBeTruthy()
  cleanup()
  vi.mocked(projectTaskCall).mockRejectedValue(new Error('method_not_found'))
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Board settings' }))
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toMatch(/Update the test server/)
  )
  expect(screen.getByRole('status').textContent).toBe('Status unavailable')
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
})

it('does not configure all projects implicitly when All projects is selected', async () => {
  render(
    <ProjectTaskBoardSettings
      client={null}
      project={undefined}
      projects={[project]}
      onChoose={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Board settings' }))
  expect(screen.getByText('Choose a project to configure its board.')).toBeTruthy()
  expect(projectTaskCall).not.toHaveBeenCalled()
})

it.each(['success', 'failure'])(
  'ignores a delayed mutation %s after switching to another project',
  async (result) => {
    const delayed = Promise.withResolvers<ProjectTaskAgentSettings>()
    vi.mocked(projectTaskCall)
      .mockResolvedValueOnce(enabled)
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(enabled)
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Board settings' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Enabled'))
    fireEvent.click(screen.getByRole('switch'))
    const other = { ...project, key: 'other', selector: 'folder:other', name: 'Other project' }
    const otherClient = { ...client, worktree: other.selector }
    view.rerender(
      <ProjectTaskBoardSettings
        client={otherClient}
        project={other}
        projects={[project, other]}
        onChoose={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Enabled'))
    await act(async () => {
      if (result === 'success') {
        delayed.resolve({ enabled: false, state: 'disabled', files: [] })
      } else {
        delayed.reject(new Error('Previous project unavailable'))
      }
    })
    expect(screen.getByRole('status').textContent).toBe('Enabled')
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
  }
)
