import { afterEach, expect, it } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { NativeClaudeCoverageObservation } from '../../shared/native-claude-coverage'

afterEach(() => _internals.resetCachesForTests())

async function fixture(source = 'startup') {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  const sessionId = '66666666-6666-4666-8666-666666666666'
  const scope = {
    paneKey: PANE,
    sessionId,
    launchId: '11111111-1111-4111-8111-111111111111',
    startedAt: Date.now() - 1
  }
  let sequence = 0
  const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) =>
    postHookEvent(server, buildBody({ hook_event_name, session_id: sessionId, ...fields }))
  await hook('SessionStart', { source })
  return {
    server,
    scope,
    hook,
    event(observation: NativeClaudeCoverageObservation) {
      return server.observeNativeClaudeCoverage(scope, {
        ...scope,
        capability: 'x'.repeat(64),
        generation: '22222222-2222-4222-8222-222222222222',
        sequence: ++sequence,
        observation
      })
    }
  }
}

it('seals only a model-admitted main prompt, never a blocked wake Stop or its retry', async () => {
  const f = await fixture()
  try {
    f.event({ kind: 'draft', active: false })
    await f.hook('UserPromptSubmit', {
      prompt_id: '33333333-3333-4333-8333-333333333333',
      prompt: 'synthetic'
    })
    f.event({ kind: 'request-start', id: 'main', mainTurnId: 'native-turn' })
    f.event({ kind: 'request-end', id: 'main' })
    await f.hook('Stop', {
      prompt_id: '33333333-3333-4333-8333-333333333333',
      background_tasks: [],
      session_crons: []
    })
    expect(
      f.event({ kind: 'complete-stop', promptId: '33333333-3333-4333-8333-333333333333' })
    ).toMatchObject({
      healthy: true,
      sealedStop: true
    })
    expect(f.server.readNativeClaudeSealedStop(f.scope)).toBe(true)
    f.event({ kind: 'turn-end', id: 'native-turn', reason: 'answer', agents: [] })
    expect(f.server.readNativeClaudeAnswerComplete(f.scope)).toBe(true)
    expect(
      f.event({ kind: 'complete-stop', promptId: '33333333-3333-4333-8333-333333333333' })
    ).toMatchObject({
      healthy: true,
      sealedStop: false
    })
    await f.hook('UserPromptSubmit', {
      prompt_id: '44444444-4444-4444-8444-444444444444',
      prompt: 'synthetic'
    })
    await f.hook('Stop', {
      prompt_id: '44444444-4444-4444-8444-444444444444',
      background_tasks: [],
      session_crons: []
    })
    expect(
      f.event({ kind: 'complete-stop', promptId: '44444444-4444-4444-8444-444444444444' })
    ).toMatchObject({
      healthy: true,
      sealedStop: false
    })
    expect(f.server.readNativeClaudeSealedStop(f.scope)).toBe(false)
  } finally {
    f.server.stop()
  }
})

it('keeps resumed unknown coverage pinned until an actual new main reaches a full Stop', async () => {
  const f = await fixture('resume')
  try {
    expect(f.event({ kind: 'draft', active: false }).healthy).toBe(false)
    await f.hook('UserPromptSubmit', {
      prompt_id: '55555555-5555-4555-8555-555555555555',
      prompt: 'synthetic'
    })
    f.event({ kind: 'request-start', id: 'main', mainTurnId: 'native-turn' })
    f.event({ kind: 'request-end', id: 'main' })
    await f.hook('StopFailure', {
      prompt_id: '55555555-5555-4555-8555-555555555555',
      error: 'rate_limit'
    })
    expect(f.server.readNativeClaudeFailureBoundary(f.scope).canSwitch()).toBe(false)
    await f.hook('Stop', {
      prompt_id: '55555555-5555-4555-8555-555555555555',
      background_tasks: [],
      session_crons: []
    })
    expect(
      f.event({ kind: 'complete-stop', promptId: '55555555-5555-4555-8555-555555555555' })
    ).toMatchObject({
      healthy: true,
      sealedStop: true
    })
  } finally {
    f.server.stop()
  }
})

it('binds each new main turn to its canonical prompt while later model steps retain that same prompt', async () => {
  const f = await fixture()
  try {
    const prompts = ['77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888']
    for (const [index, promptId] of prompts.entries()) {
      await f.hook('UserPromptSubmit', { prompt_id: promptId, prompt: `synthetic turn ${index}` })
      f.event({ kind: 'turn-start', id: `turn-${index}` })
      f.event({ kind: 'request-start', id: `model-${index}`, mainTurnId: `turn-${index}` })
      expect(
        f.server._getStateForTests().claudeLeadStateByPaneKey.get(PANE)?.nativeCoverage
          ?.currentMainPromptId
      ).toBe(promptId)
      f.event({ kind: 'request-end', id: `model-${index}` })
      await f.hook('Stop', { prompt_id: promptId, background_tasks: [], session_crons: [] })
      expect(f.event({ kind: 'complete-stop', promptId })).toMatchObject({
        healthy: true,
        sealedStop: true
      })
    }
  } finally {
    f.server.stop()
  }
})

it('keeps private continuity and the exact failure receipt when legacy observers duplicate native events', async () => {
  const f = await fixture()
  try {
    f.event({ kind: 'draft', active: true })
    const lead = () => f.server._getStateForTests().claudeLeadStateByPaneKey.get(PANE)
    const coverage = lead()?.nativeCoverage
    await f.hook('SessionStart', { source: 'startup' })
    expect(lead()?.nativeCoverage).toBe(coverage)
    expect(lead()?.nativeCoverage?.draftActive).toBe(true)
    const promptId = '99999999-9999-4999-8999-999999999999'
    await f.hook('UserPromptSubmit', { prompt_id: promptId })
    f.event({ kind: 'request-start', id: 'main', mainTurnId: 'native-main' })
    f.event({ kind: 'request-end', id: 'main' })
    await f.hook('StopFailure', { prompt_id: promptId, error: 'rate_limit' })
    const failure = lead()?.nativeFailure
    expect(failure?.turnId).toBe('native-main')
    await f.hook('StopFailure', { prompt_id: promptId, error: 'rate_limit' })
    expect(lead()?.nativeFailure).toBe(failure)
    expect(f.server.readNativeClaudeFailureBoundary(f.scope).canSwitch()).toBe(false)
  } finally {
    f.server.stop()
  }
})

it('attaches a late answer only to its exact sealed main turn, never a child or newer input', async () => {
  const f = await fixture()
  try {
    const promptId = '33333333-3333-4333-8333-333333333333'
    await f.hook('UserPromptSubmit', { prompt_id: promptId })
    f.event({ kind: 'request-start', id: 'main', mainTurnId: 'sealed-main' })
    f.event({ kind: 'request-end', id: 'main' })
    await f.hook('Stop', { prompt_id: promptId, background_tasks: [], session_crons: [] })
    f.event({ kind: 'complete-stop', promptId })
    expect(f.server.readNativeClaudeAnswerComplete(f.scope)).toBe(false)
    f.event({ kind: 'turn-end', id: 'sealed-main', agentId: 'child', reason: 'answer', agents: [] })
    expect(f.server.readNativeClaudeAnswerComplete(f.scope)).toBe(false)
    f.event({ kind: 'turn-end', id: 'sealed-main', reason: 'error', agents: [] })
    expect(f.server.readNativeClaudeAnswerComplete(f.scope)).toBe(false)
    f.event({ kind: 'turn-end', id: 'sealed-main', reason: 'answer', agents: [] })
    expect(f.server.readNativeClaudeAnswerComplete(f.scope)).toBe(false)
    f.event({ kind: 'prompt', origin: 'composer', submissionId: 'new-input' })
    expect(f.server.readNativeClaudeAnswerComplete(f.scope)).toBe(false)
  } finally {
    f.server.stop()
  }
})
