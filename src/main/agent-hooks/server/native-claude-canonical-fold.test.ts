import { expect, it } from 'vitest'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { foldNativeClaudeCanonicalHook } from './native-claude-canonical-fold'
const nativeId = '10000000-0000-4000-8000-000000000001',
  promptId = '20000000-0000-4000-8000-000000000001'
it('folds private real-pane metadata without publishing a legacy row', () => {
  const state = createHookListenerState(),
    key = 'real-terminal-pane:real-incarnation'
  foldNativeClaudeCanonicalHook(state, key, {
    nativeOrigin: 'engine',
    event: 'SessionStart',
    sessionId: nativeId,
    source: 'startup'
  })
  foldNativeClaudeCanonicalHook(state, key, {
    nativeOrigin: 'engine',
    event: 'UserPromptSubmit',
    sessionId: nativeId,
    promptId
  })
  expect(state.claudeLeadStateByPaneKey.get(key)).toMatchObject({
    state: 'working',
    nativeStart: { sessionId: nativeId },
    nativePromptId: promptId
  })
  expect(state.lastStatusByPaneKey.size).toBe(0)
})
it('does not repair an absent roster into an authoritative empty inventory', () => {
  const state = createHookListenerState(),
    key = 'real-terminal-pane:real-incarnation'
  foldNativeClaudeCanonicalHook(state, key, {
    nativeOrigin: 'engine',
    event: 'UserPromptSubmit',
    sessionId: nativeId,
    promptId
  })
  const stopped = foldNativeClaudeCanonicalHook(state, key, {
    nativeOrigin: 'engine',
    event: 'Stop',
    sessionId: nativeId,
    promptId
  })
  expect(stopped?.lead?.nativeHook?.backgroundTasksComplete).toBe(false)
})
it('does not reinterpret compact or unknown startup as a fresh idle Start', () => {
  const state = createHookListenerState(),
    key = 'real-terminal-pane:real-incarnation'
  foldNativeClaudeCanonicalHook(state, key, {
    nativeOrigin: 'engine',
    event: 'UserPromptSubmit',
    sessionId: nativeId,
    promptId
  })
  for (const source of ['compact', 'fork', 'unknown']) {
    expect(
      foldNativeClaudeCanonicalHook(state, key, {
        nativeOrigin: 'engine',
        event: 'SessionStart',
        sessionId: nativeId,
        source
      })
    ).toBeNull()
  }
  expect(state.claudeLeadStateByPaneKey.get(key)?.state).toBe('working')
})
