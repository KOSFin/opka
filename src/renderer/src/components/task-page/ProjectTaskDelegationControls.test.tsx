// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PROJECT_TASK_PROJECT_AGENTS_CAPABILITY } from '../../../../shared/project-task-delegation'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { projectTaskCall } from './project-task-client'
import { ProjectTaskDelegationControls } from './ProjectTaskDelegationControls'
import type { TaskProjectScope } from './project-task-projects'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('./project-task-client', () => ({ projectTaskCall: vi.fn() }))
const project: TaskProjectScope = {
  key: 'local',
  selector: 'folder:synthetic',
  root: '/synthetic',
  name: 'Synthetic',
  hostLabel: 'Test host',
  target: { kind: 'local' },
  state: 'configured'
}
const client = { target: project.target, worktree: project.selector, executionHostId: 'host-one' }
const policy = { generation: 2, grant: null }

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.useRealTimers()
})

it('keeps an old peer manual without attempting a policy method', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({ capabilities: [] })
  render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(screen.getByText(/delegated controls unavailable/)).toBeTruthy())
  expect(projectTaskCall).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Allow agents…' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh policy' })).toBeNull()
})

it('keeps policy retry available after a transient initial read failure', async () => {
  vi.mocked(callRuntimeRpc)
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce({ capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY] })
  vi.mocked(projectTaskCall).mockResolvedValue(policy)
  render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Refresh'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh policy' }))
  await waitFor(() => expect(screen.getByText(/Manual · generation 2/)).toBeTruthy())
  expect(vi.mocked(projectTaskCall)).toHaveBeenCalledTimes(1)
})

it('keeps one retry pending after policy.read fails and does not expose the stale grant', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY]
  })
  const retry = Promise.withResolvers<typeof policy>()
  vi.mocked(projectTaskCall).mockRejectedValueOnce(new Error('connection lost'))
  vi.mocked(projectTaskCall).mockReturnValueOnce(retry.promise)
  render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Refresh'))
  const refresh = screen.getByRole('button', { name: 'Refresh policy' })
  fireEvent.click(refresh)
  fireEvent.click(refresh)
  expect(refresh.hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Allow agents…' })).toBeNull()
  await waitFor(() => expect(vi.mocked(projectTaskCall)).toHaveBeenCalledTimes(2))
  await act(async () => retry.resolve(policy))
  await waitFor(() => expect(screen.getByText(/Manual · generation 2/)).toBeTruthy())
})

it('keeps retry after a failed mutation reread without reusing the old policy', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY]
  })
  vi.mocked(projectTaskCall)
    .mockResolvedValueOnce(policy)
    .mockRejectedValueOnce(new Error('generation conflict'))
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce({ generation: 3, grant: null })
  render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(screen.getByText(/Manual · generation 2/)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Allow agents…' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Refresh'))
  await waitFor(() => expect(vi.mocked(projectTaskCall)).toHaveBeenCalledTimes(3))
  expect(screen.queryByRole('button', { name: 'Allow agents…' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh policy' }))
  await waitFor(() => expect(screen.getByText(/Manual · generation 3/)).toBeTruthy())
  expect(vi.mocked(projectTaskCall)).toHaveBeenCalledTimes(4)
})

it('ignores a late retry from the previous host and project', async () => {
  const oldRetry = Promise.withResolvers<{ capabilities: string[] }>()
  vi.mocked(callRuntimeRpc)
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockReturnValueOnce(oldRetry.promise)
    .mockResolvedValue({ capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY] })
  vi.mocked(projectTaskCall).mockResolvedValue({ generation: 7, grant: null })
  const view = render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Refresh policy' }))
  const other = { target: project.target, worktree: 'folder:other', executionHostId: 'host-two' }
  view.rerender(
    <ProjectTaskDelegationControls
      client={other}
      project={{ ...project, key: 'other', name: 'Other' }}
    />
  )
  await waitFor(() => expect(screen.getByText(/Manual · generation 7/)).toBeTruthy())
  await act(async () =>
    oldRetry.resolve({ capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY] })
  )
  expect(vi.mocked(projectTaskCall)).toHaveBeenCalledTimes(1)
  expect(vi.mocked(projectTaskCall).mock.calls[0]?.[0]).toBe(other)
  expect(screen.getByText(/Manual · generation 7/)).toBeTruthy()
})

it('reviews the host-normalized exact grant and confirms only once', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY]
  })
  const confirmed = Promise.withResolvers<unknown>()
  const grant = {
    schema: 1,
    generation: 3,
    binding: {
      installationId: 'installation',
      machineBinding: 'machine',
      projectId: 'project',
      root: '/real/synthetic',
      configRevision: 'a'.repeat(64)
    },
    actor: { key: 'verified-key', aliases: ['verified-key'] },
    actorAddress: 'term_verified',
    actions: ['approve-plan'],
    runId: null,
    taskIds: null,
    expiresAt: Date.now() + 60_000
  }
  vi.mocked(projectTaskCall)
    .mockResolvedValueOnce(policy)
    .mockResolvedValueOnce({
      id: '11111111-1111-4111-8111-111111111111',
      digest: 'b'.repeat(64),
      grant,
      expectedGeneration: 2
    })
    .mockReturnValueOnce(confirmed.promise)
    .mockResolvedValueOnce(policy)
  render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(screen.getByText(/Manual · generation 2/)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Allow agents…' }))
  await waitFor(() => expect(screen.getByText('Root: /real/synthetic')).toBeTruthy())
  expect(screen.getByText(/verified agent sessions and terminals/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm on this host' }))
  await waitFor(() =>
    expect(
      vi.mocked(projectTaskCall).mock.calls.filter((call) => call[1] === 'policy.confirm')
    ).toHaveLength(1)
  )
  expect(screen.queryByRole('button', { name: 'Confirm on this host' })).toBeNull()
  await act(async () => confirmed.resolve({ operation: 'policy.installed' }))
})

it('drops a late policy reply after the selected project changes', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY]
  })
  const first = Promise.withResolvers<unknown>()
  vi.mocked(projectTaskCall)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ generation: 7, grant: null })
  const view = render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(vi.mocked(projectTaskCall)).toHaveBeenCalledTimes(1))
  const other = { target: project.target, worktree: 'folder:other', executionHostId: 'host-two' }
  view.rerender(
    <ProjectTaskDelegationControls
      client={other}
      project={{ ...project, key: 'other', name: 'Other' }}
    />
  )
  await waitFor(() => expect(screen.getByText(/Manual · generation 7/)).toBeTruthy())
  await act(async () => first.resolve(policy))
  expect(screen.getByText(/Manual · generation 7/)).toBeTruthy()
})

it('switches an expiring grant to manual review at its expiry', async () => {
  vi.useFakeTimers()
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY]
  })
  vi.mocked(projectTaskCall).mockResolvedValue({
    generation: 3,
    grant: {
      schema: 1,
      generation: 3,
      binding: {
        installationId: 'installation',
        machineBinding: 'machine',
        projectId: 'project',
        root: '/synthetic',
        configRevision: 'a'.repeat(64)
      },
      actor: { key: 'verified-key', aliases: ['verified-key'] },
      actorAddress: 'term_verified',
      actions: ['approve-plan'],
      runId: null,
      taskIds: null,
      expiresAt: Date.now() + 1_000
    }
  })
  await act(async () => {
    render(<ProjectTaskDelegationControls client={client} project={project} />)
  })
  expect(screen.getByText(/Delegated policy · generation 3/)).toBeTruthy()
  await act(async () => vi.advanceTimersByTime(1_000))
  expect(screen.getByText(/Manual review required · grant expired/)).toBeTruthy()
})

it('shows a project-wide grant as active until revoked without an expiry timer', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    capabilities: [PROJECT_TASK_PROJECT_AGENTS_CAPABILITY]
  })
  vi.mocked(projectTaskCall).mockResolvedValue({
    generation: 3,
    grant: {
      schema: 2,
      generation: 3,
      binding: {
        installationId: 'installation',
        machineBinding: 'machine',
        projectId: 'project',
        root: '/synthetic',
        configRevision: 'a'.repeat(64)
      },
      scope: 'project-agents',
      actions: ['approve-plan', 'request-changes', 'send-to-integration', 'accept-result'],
      expiresAt: null
    }
  })
  render(<ProjectTaskDelegationControls client={client} project={project} />)
  await waitFor(() => expect(screen.getByText(/Agents allowed · generation 3/)).toBeTruthy())
  expect(screen.getByText(/until revoked/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Manual approval…' })).toBeTruthy()
})
