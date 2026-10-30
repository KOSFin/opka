import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_WORKER_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
vi.mock('../format', () => ({ printResult: vi.fn() }))
import { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_HANDLERS } from './orchestration'
const callMock = vi.fn()
const client = new RuntimeClient('/tmp/opka-synthetic-client', 60_000, null, null, 'opka')
vi.spyOn(client, 'call').mockImplementation(callMock)
afterEach(() => callMock.mockReset())
const invokeWorkerStart = (flags: Map<string, string | boolean>) =>
  ORCHESTRATION_HANDLERS['orchestration worker-start']({
    flags,
    client,
    cwd: '/tmp/synthetic',
    json: true
  })
it('refuses account routing before mutation when the owning runtime is older', async () => {
  callMock.mockResolvedValueOnce({ result: { capabilities: [] } })
  await expect(
    invokeWorkerStart(
      new Map([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['account', 'account_b']
      ])
    )
  ).rejects.toMatchObject({ code: 'incompatible_runtime' })
  expect(callMock).toHaveBeenCalledTimes(1)
  expect(callMock).toHaveBeenCalledWith('status.get')
})

it('forwards an opaque account only after capability negotiation', async () => {
  callMock.mockResolvedValueOnce({
    result: { capabilities: [ORCHESTRATION_WORKER_ACCOUNT_RUNTIME_CAPABILITY] }
  })
  callMock.mockResolvedValueOnce({
    result: { state: 'ready', effects: [], residualResources: [] }
  })
  await invokeWorkerStart(
    new Map([
      ['task', 'task_1'],
      ['agent', 'codex'],
      ['account', 'account_b'],
      ['from', 'term_coord']
    ])
  )
  expect(callMock).toHaveBeenCalledWith(
    'orchestration.workerStart',
    expect.objectContaining({ accountId: 'account_b', agent: 'codex' })
  )
})
