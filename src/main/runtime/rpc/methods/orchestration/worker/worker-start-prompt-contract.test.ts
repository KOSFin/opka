import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../../../../agent-prompt-submission-runtime-test-fixture'
import {
  createPromptContractHarness,
  reopenPromptContractDb,
  disposePromptContractHarnesses
} from './worker-start-prompt-contract-fixture'

describe('orchestration worker-start prompt contract', () => {
  afterEach(disposePromptContractHarnesses)

  it('durably accepts exactly one submitted and started turn', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('accepted')
    const pending = harness.dispatcher.dispatch(harness.request)

    await vi.runAllTimersAsync()
    const response = await pending
    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'ready',
        stage: 'input_accepted',
        mutation: { requestId: harness.requestId, replayed: false },
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
        ])
      }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const dispatchId = (response.result as { dispatchId: string }).dispatchId
    expect(harness.submittedTurns()).toBe(1)
    expect(harness.startedTurns()).toBe(1)
    expect(harness.prematureSubmits()).toBe(0)
    expect(harness.writes.filter((data) => data === '\r')).toHaveLength(1)
    const persisted = reopenPromptContractDb(harness)
    expect(persisted.getTask(harness.taskId)?.status).toBe('dispatched')
    expect(persisted.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'dispatched',
      capability_revoked_at: null
    })
    expect(persisted.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted',
      last_error: null
    })
    const callerFingerprint = persisted.getOrCreateLocalMutationCallerFingerprint()
    const receipt = persisted.getMutationReceipt(callerFingerprint, harness.requestId)
    expect(receipt).toMatchObject({ state: 'completed' })
    expect(JSON.parse(receipt?.receipt ?? 'null')).toMatchObject({
      dispatchId,
      state: 'ready',
      stage: 'input_accepted'
    })
  })

  it.each([
    ['succeeded', false],
    ['succeeded', true],
    ['failed', false],
    ['failed', true]
  ] as const)('preserves an early %s report with turn evidence=%s', async (outcome, observed) => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    vi.spyOn(harness.runtime, 'observeTerminalAgentPrompt').mockImplementation(
      async (_handle, prompt) => {
        const dispatch = harness.db.findActiveDispatchForAssignee(harness.handle)
        expect(dispatch).toBeDefined()
        expect(
          harness.db.settleWorkerReport({
            taskId: harness.taskId,
            dispatchId: dispatch!.id,
            outcome,
            result: 'Finished before the hook arrived'
          })
        ).toMatchObject({ action: 'settled', outcome })
        return observed ? { ...prompt, stages: ['input_accepted', 'turn_started'] } : prompt
      }
    )
    const pending = harness.dispatcher.dispatch(harness.request)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({
      ok: true,
      result: { state: 'ready', stage: 'settled', workerOutcome: outcome }
    })
    expect(harness.db.getTask(harness.taskId)?.status).toBe(
      outcome === 'succeeded' ? 'completed' : 'failed'
    )
  })

  it('retains accepted authority when the observation binding becomes stale', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    vi.spyOn(harness.runtime, 'observeTerminalAgentPrompt').mockRejectedValue(
      new Error('terminal_handle_stale')
    )
    const pending = harness.dispatcher.dispatch(harness.request)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
    expect(harness.db.findActiveDispatchForAssignee(harness.handle)).toMatchObject({
      status: 'pending',
      capability_revoked_at: null
    })
    expect(harness.submittedTurns()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a worker question answerable after turn observation times out', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    let questionId = ''
    vi.spyOn(harness.runtime, 'observeTerminalAgentPrompt').mockImplementation(
      async (_handle, prompt) => {
        const dispatch = harness.db.findActiveDispatchForAssignee(harness.handle)!
        questionId = harness.db.createQuestion({
          runId: dispatch.run_id!,
          dispatchId: dispatch.id,
          askerHandle: harness.handle,
          question: 'Which target should I use?'
        }).question.message_id
        return prompt
      }
    )
    const pending = harness.dispatcher.dispatch(harness.request)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
    expect(harness.db.getQuestion(questionId)?.status).toBe('pending')
  })

  it('reports a swallowed Enter as start_unknown while keeping the worker reportable', async () => {
    vi.useFakeTimers()
    const harness = await createPromptContractHarness('swallowed')
    const pending = harness.dispatcher.dispatch(harness.request)

    await vi.runAllTimersAsync()
    const response = await pending
    // Codex supports turn-start observation and no turn started, so ready would be a lie: the
    // paste can sit unsent in the composer while the receipt looks like a healthy dispatch.
    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'outcome_unknown',
        stage: 'turn_start_unobserved',
        turnStart: 'unobserved',
        prompt: {
          requestId: harness.requestId,
          stages: ['input_accepted']
        },
        nextCommands: expect.arrayContaining([expect.stringContaining('worker-show')]),
        mutation: { requestId: harness.requestId, replayed: false }
      }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const dispatchId = (response.result as { dispatchId: string }).dispatchId
    await vi.advanceTimersByTimeAsync(20_000)
    // Unverifiable is not failure: exactly one submit, no blind retry, nothing torn down.
    expect(harness.submittedTurns()).toBe(1)
    expect(harness.startedTurns()).toBe(0)
    expect(harness.prematureSubmits()).toBe(0)
    expect(harness.writes.filter((data) => data === '\r')).toHaveLength(1)
    const persisted = reopenPromptContractDb(harness)
    expect(persisted.getTask(harness.taskId)?.status).toBe('blocked')
    expect(persisted.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'pending',
      last_failure: null,
      // Lifecycle stays open so a worker that recovers can still report; worker-report
      // settlement reconnects a start_unknown worker through 'ready'.
      capability_revoked_at: null
    })
    expect(persisted.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'start_unknown',
      stage: 'turn_start_unobserved',
      last_error: expect.stringContaining('turn start could not be verified')
    })
    const persistedEffects = JSON.parse(
      persisted.getWorkerDispatch(dispatchId)?.effects ?? '[]'
    ) as { kind?: string; state?: string }[]
    expect(persistedEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' }),
        expect.objectContaining({ kind: 'dispatch_input', state: 'turn_unobserved' })
      ])
    )
    const callerFingerprint = persisted.getOrCreateLocalMutationCallerFingerprint()
    const receipt = persisted.getMutationReceipt(callerFingerprint, harness.requestId)
    expect(receipt).toMatchObject({ state: 'completed' })
    expect(JSON.parse(receipt?.receipt ?? 'null')).toMatchObject({
      dispatchId,
      state: 'outcome_unknown',
      stage: 'turn_start_unobserved',
      prompt: {
        requestId: harness.requestId,
        stages: ['input_accepted']
      }
    })
  })

  it('does not attribute output from the old busy turn to a queued prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined, 'codex')
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
    const pending = runtime.sendTerminalAgentPrompt(handle, 'queued prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'busy-swallowed',
      observationTimeoutMs: 0
    })

    await vi.runAllTimersAsync()
    const send = await pending
    expect(send).toMatchObject({
      prompt: {
        requestId: 'busy-swallowed',
        stages: ['input_accepted']
      }
    })
    const observed = runtime.observeTerminalAgentPrompt(handle, send.prompt!, 1_000)
    setTimeout(() => {
      runtime.onPtyData('pty-prompt', 'old turn output', Date.now())
    }, 50)
    await vi.runAllTimersAsync()

    await expect(observed).resolves.toMatchObject({
      stages: ['input_accepted']
    })
  })

  it('refuses an 8 MiB inline spec before Task, Dispatch, or terminal effects', async () => {
    const harness = await createPromptContractHarness('accepted')
    const tasksBefore = harness.db.listTasks().map((task) => task.id)
    const params = harness.request.params as Record<string, unknown>
    delete params.task
    params.spec = 'x'.repeat(8 * 1024 * 1024)

    const response = await harness.dispatcher.dispatch(harness.request)

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'worker_prompt_too_large',
        data: { effectsApplied: false, maxTaskSpecBytes: expect.any(Number) }
      }
    })
    expect(harness.db.listTasks().map((task) => task.id)).toEqual(tasksBefore)
    expect(harness.db.getDispatchContext(harness.taskId)).toBeUndefined()
    expect(harness.writes).toEqual([])
  })
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
