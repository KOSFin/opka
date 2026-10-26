import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { claimProjectTaskSession } from './project-task-session'
import { projectTaskResources } from './project-task-workflow-service'

vi.mock('./project-task-workflow-service', () => ({ projectTaskResources: vi.fn() }))

const handle = 'term_task_fixture'
const paneKey = 'tab_task_fixture:77777777-7777-4777-8777-777777777777'
const token = 'synthetic-launch-token'
const evidence = { terminalHandle: handle, paneKey, launchToken: token }
const params = {
  worktree: 'path:/synthetic',
  id: 'task-fixture',
  revision: 'a'.repeat(64),
  expectedExecutionHostId: 'local'
}
let runtime: OrcaRuntimeService
let db: OrchestrationDb

beforeEach(() => {
  runtime = new OrcaRuntimeService()
  db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(paneKey)
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((candidate) =>
    candidate === handle
      ? {
          runtimeId: 'runtime-fixture',
          terminalHandle: handle,
          ptyId: 'pty-fixture',
          worktreeId: 'folder:fixture',
          processIncarnation: 'pty-fixture:incarnation',
          paneKey,
          launchTokenHash: createHash('sha256').update(token).digest('hex'),
          hostScope: { kind: 'local', hostId: 'local' }
        }
      : null
  )
  vi.mocked(projectTaskResources).mockRejectedValue(new Error('Synthetic storage boundary'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  db.close()
})

it('admits a freshly launched owning terminal without inventing an agent hook', async () => {
  expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
  await expect(
    claimProjectTaskSession(params, { runtime, orchestrationCompatibilityEvidence: evidence })
  ).rejects.toThrow('Synthetic storage boundary')
  expect(projectTaskResources).toHaveBeenCalledOnce()
})

it.each([
  { terminalHandle: 'term_other' },
  { paneKey: 'tab_other:77777777-7777-4777-8777-777777777777' },
  { launchToken: 'wrong-launch-token' },
  { launchToken: undefined },
  { host: { kind: 'wsl' as const, hostId: 'local', distro: 'different-host' } }
])('refuses unverifiable or mismatched terminal evidence %j', async (change) => {
  await expect(
    claimProjectTaskSession(params, {
      runtime,
      orchestrationCompatibilityEvidence: { ...evidence, ...change }
    })
  ).rejects.toThrow()
  expect(projectTaskResources).not.toHaveBeenCalled()
})

it('refuses another declared handle even when the supplied launch proof is valid', async () => {
  await expect(
    claimProjectTaskSession(
      { ...params, from: 'term_other' },
      { runtime, orchestrationCompatibilityEvidence: evidence }
    )
  ).rejects.toThrow(/does not match/)
  expect(projectTaskResources).not.toHaveBeenCalled()
})

it('does not downgrade invalid task proof to a valid legacy launch token', async () => {
  await expect(
    claimProjectTaskSession(params, {
      runtime,
      orchestrationCompatibilityEvidence: { ...evidence, terminalTaskProof: '0'.repeat(64) }
    })
  ).rejects.toThrow(/could not verify/)
  expect(projectTaskResources).not.toHaveBeenCalled()
})

it('does not turn an unattested restored terminal into a fresh launch', async () => {
  const authority = runtime.getOrchestrationDispatchAuthority(handle)
  if (!authority) {
    throw new Error('Synthetic authority missing')
  }
  vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue({
    ...authority,
    launchTokenHash: null
  })
  await expect(
    claimProjectTaskSession(params, { runtime, orchestrationCompatibilityEvidence: evidence })
  ).rejects.toThrow(/could not verify/)
  expect(projectTaskResources).not.toHaveBeenCalled()
})
