import { expect, it, vi } from 'vitest'
import { createNativeClaudeSessionBoundary } from './native-claude-session-boundary'

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    observeNativeClaudeCoverage: (_owner: unknown, request: { sequence: number }) => ({
      sequence: request.sequence,
      healthy: true,
      replayed: false,
      sealedStop: false
    }),
    isKnownNativeClaudeCoverageTask: () => false,
    readNativeClaudeFailureBoundary: () => ({
      promptId: 'native-failed-prompt',
      canSwitch: () => true,
      onBoundaryAccepted: () => {}
    })
  }
}))

it('keeps capability observations authorized when saved hooks are off while pausing account changes', () => {
  let enabled = false,
    current = true
  const boundary = createNativeClaudeSessionBoundary({
    launchId: '11111111-1111-4111-8111-111111111111',
    startedAt: 1,
    managedCoverage: true,
    transitions: { subscribe: () => () => {}, latestRow: () => null },
    readPhysicalOwner: () => ({
      paneKey: 'pane',
      ptyId: 'pty',
      incarnationId: 'actual-incarnation'
    }),
    isCurrent: () => current,
    isEnabled: () => enabled
  })
  const request = {
    launchId: '11111111-1111-4111-8111-111111111111',
    capability: 'x'.repeat(64),
    sessionId: 'actual-native-session',
    generation: '22222222-2222-4222-8222-222222222222',
    sequence: 1,
    observation: { kind: 'draft', active: false } as const
  }
  try {
    expect(boundary.observe(request).ack.healthy).toBe(true)
    expect(boundary.readOwner()?.sessionId).toBe('actual-native-session')
    expect(boundary.readBoundary().canSwitch()).toBe(false)
    enabled = true
    expect(boundary.readBoundary().canSwitch()).toBe(true)
    current = false
    expect(() => boundary.observe({ ...request, sequence: 2 })).toThrow('ownership')
    expect(boundary.readBoundary().canSwitch()).toBe(false)
  } finally {
    boundary.dispose()
  }
})
