import { beforeEach, expect, it, vi } from 'vitest'
import { probeForkCodexStartup } from './fork-codex-startup'

const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(),
  open: vi.fn()
}))
vi.mock('../../../src/main/codex/codex-app-server-connection', () => ({
  openCodexAppServerConnection: fixture.open
}))
beforeEach(() => {
  vi.clearAllMocks()
  fixture.open.mockResolvedValue({ request: fixture.request, close: fixture.close })
  fixture.request.mockResolvedValue({})
  fixture.close.mockResolvedValue(true)
})

it('checks real transport readiness without any turn or model prompt', async () => {
  await probeForkCodexStartup('/synthetic/codex', '/synthetic/project', {
    CODEX_HOME: '/synthetic/home',
    OPTIONAL: undefined
  })
  expect(fixture.open).toHaveBeenCalledWith(
    expect.objectContaining({
      command: '/synthetic/codex',
      cwd: '/synthetic/project',
      args: ['app-server'],
      env: { CODEX_HOME: '/synthetic/home', RUST_LOG: 'warn' }
    })
  )
  expect(fixture.request).toHaveBeenCalledExactlyOnceWith(
    'thread/start',
    {
      cwd: '/synthetic/project',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request'
    },
    { timeoutMs: 15000 }
  )
  expect(fixture.close).toHaveBeenCalledTimes(1)
})

it('closes the owned process and preserves a failed startup instead of reporting readiness', async () => {
  const failure = new Error('SQLite unavailable')
  fixture.request.mockRejectedValue(failure)
  await expect(probeForkCodexStartup('/synthetic/codex', '/synthetic/project', {})).rejects.toBe(
    failure
  )
  expect(fixture.close).toHaveBeenCalledTimes(1)
})

it('does not report success when process exit remains unverified', async () => {
  fixture.close.mockResolvedValue(false)
  await expect(probeForkCodexStartup('/synthetic/codex', '/synthetic/project', {})).rejects.toThrow(
    'did not confirm its process exit'
  )
})

it('checks task skill discovery before allowing a paid turn', async () => {
  fixture.request.mockResolvedValue({ data: [{ skills: [{ name: 'opka-tasks' }] }] })
  await probeForkCodexStartup('/synthetic/codex', '/synthetic/project', {}, 'opka-tasks')
  expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
    'thread/start',
    'skills/list'
  ])
  expect(fixture.close).toHaveBeenCalledTimes(1)
})

it('refuses an undiscovered skill and still closes the process without inference', async () => {
  await expect(
    probeForkCodexStartup('/synthetic/codex', '/synthetic/project', {}, 'opka-tasks')
  ).rejects.toThrow('did not discover')
  expect(fixture.close).toHaveBeenCalledTimes(1)
  expect(fixture.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
})
