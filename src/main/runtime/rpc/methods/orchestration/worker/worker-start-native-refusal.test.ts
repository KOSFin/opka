import { afterEach, expect, it, vi } from 'vitest'
import { NativeCliControlError } from '../../../../../../shared/native-cli-control-error'
import {
  createPromptContractHarness,
  disposePromptContractHarnesses
} from './worker-start-prompt-contract-fixture'

afterEach(disposePromptContractHarnesses)
it('persists the fixed startup refusal in the existing Task/Dispatch before any prompt delivery', async () => {
  const f = await createPromptContractHarness('accepted')
  vi.spyOn(f.runtime, 'waitForFreshWorkerComposer').mockRejectedValue(
    new NativeCliControlError('config_conflict')
  )
  vi.spyOn(f.runtime, 'waitForTerminal').mockRejectedValue(
    new NativeCliControlError('config_conflict')
  )
  const response = await f.dispatcher.dispatch(f.request)
  expect(response).toMatchObject({
    ok: true,
    result: {
      state: 'failed',
      failedStage: 'agent_readiness',
      failureCode: 'native_cli_config_conflict',
      lastError: new NativeCliControlError('config_conflict').message
    }
  })
  expect(f.submittedTurns()).toBe(0)
  expect(f.startedTurns()).toBe(0)
  expect(f.writes).toEqual([])
  expect(f.db.getTask(f.taskId)?.status).toBe('failed')
  expect(f.db.getDispatchContext(f.taskId)?.status).not.toBe('pending')
})

vi.mock('../../../../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-contract',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-contract',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))
