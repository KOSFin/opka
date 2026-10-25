import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { dispatch } from '../dispatch'
import { parseArgs } from '../args'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
function fixture() {
  const client = new RuntimeClient()
  const call = vi.spyOn(client, 'call').mockImplementation(async (method) => ({
    id: 'request',
    ok: true,
    result: method === 'projectTask.target' ? { executionHostId: 'local' } : {},
    _meta: { runtimeId: 'own-runtime' }
  }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const run = (verb: string, extra: [string, string][] = []) =>
    dispatch(['project-task', verb], {
      client,
      cwd: process.cwd(),
      json: true,
      flags: new Map([
        ['worktree', 'folder:fixture'],
        ['id', 'task-one'],
        ['revision', 'a'.repeat(64)],
        ...extra
      ])
    })
  return { call, run, client }
}

it('routes ordinary-chat lifecycle commands through host preflight with terminal identity', async () => {
  vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
  vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term-own')
  const { call, run, client } = fixture()
  await run('claim')
  expect(call).toHaveBeenLastCalledWith(
    'projectTask.claim',
    expect.objectContaining({ from: 'term-own', expectedExecutionHostId: 'local' })
  )
  await run('progress', [
    ['attempt', 'attempt-one'],
    ['checkpoint', 'Next: contract'],
    ['blocker', 'API contract missing']
  ])
  expect(call).toHaveBeenLastCalledWith(
    'projectTask.progress',
    expect.objectContaining({
      checkpoint: 'Next: contract',
      blocker: 'API contract missing',
      attempt: 'attempt-one'
    })
  )
  await run('documents', [['path', 'docs/work/tasks/one/checkpoint.md']])
  expect(call).toHaveBeenLastCalledWith(
    'projectTask.documents',
    expect.objectContaining({ path: 'docs/work/tasks/one/checkpoint.md' })
  )
  await dispatch(['project-task', 'progress'], {
    client,
    cwd: process.cwd(),
    json: true,
    flags: new Map<string, string | boolean>([
      ['worktree', 'folder:fixture'],
      ['id', 'task-one'],
      ['revision', 'a'.repeat(64)],
      ['attempt', 'attempt-one'],
      ['checkpoint', 'Handoff'],
      ['release', true]
    ])
  })
  expect(call).toHaveBeenLastCalledWith(
    'projectTask.progress',
    expect.objectContaining({ release: true })
  )
})

it('does not send inherited terminal authority over a structured session identity', async () => {
  vi.stubEnv('ORCA_AGENT_SESSION_ID', '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
  vi.stubEnv('ORCA_TERMINAL_HANDLE', 'parent-terminal')
  const { call, run } = fixture()
  await run('claim')
  expect(call).toHaveBeenLastCalledWith(
    'projectTask.claim',
    expect.objectContaining({ from: undefined })
  )
})

it('requires an actual report and tells an old host to update rather than using a fallback', async () => {
  const { call, run } = fixture()
  await expect(
    run('complete', [
      ['attempt', 'attempt-one'],
      ['checkpoint', 'Next: review']
    ])
  ).rejects.toMatchObject({ code: 'invalid_argument' })
  expect(call).not.toHaveBeenCalled()
  call.mockRejectedValue(new RuntimeClientError('method_not_found', 'Unknown method'))
  await expect(run('claim')).rejects.toMatchObject({ code: 'incompatible_runtime' })
  expect(call).toHaveBeenCalledTimes(1)
})

it('parses release as a boolean rather than consuming a command or checkpoint argument', () => {
  const parsed = parseArgs(['--release', 'project-task', 'progress', '--checkpoint', 'Handoff'])
  expect(parsed.flags.get('release')).toBe(true)
  expect(parsed.flags.get('checkpoint')).toBe('Handoff')
  expect(parsed.commandPath).toEqual(['project-task', 'progress'])
})
