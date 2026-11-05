import { expect, it } from 'vitest'
import { ownsNativeClaudeGatewaySession } from './native-claude-gateway-session-ownership'

const owner = {
  currentSessionId: 'current-native-root',
  canonicalSessionId: 'retained-native-root',
  isKnownChild: (id: string) => ['actual-child', 'actual-nested-child'].includes(id)
}
it('permits the current root and canonical known native children without relabeling their session IDs', () => {
  expect(ownsNativeClaudeGatewaySession({ sessionId: owner.currentSessionId }, owner)).toBe(true)
  expect(
    ownsNativeClaudeGatewaySession(
      { sessionId: 'actual-child', parentSessionId: owner.currentSessionId },
      owner
    )
  ).toBe(true)
  expect(
    ownsNativeClaudeGatewaySession(
      { sessionId: 'actual-child', parentSessionId: owner.canonicalSessionId },
      owner
    )
  ).toBe(true)
  expect(
    ownsNativeClaudeGatewaySession(
      { sessionId: 'actual-nested-child', parentSessionId: 'actual-child' },
      owner
    )
  ).toBe(true)
  expect(ownsNativeClaudeGatewaySession({ sessionId: 'actual-child' }, owner)).toBe(true)
})
it('refuses unknown child or parent associations instead of guessing current work ownership', () => {
  expect(
    ownsNativeClaudeGatewaySession(
      { sessionId: 'foreign-child', parentSessionId: owner.currentSessionId },
      owner
    )
  ).toBe(false)
  expect(
    ownsNativeClaudeGatewaySession(
      { sessionId: 'actual-child', parentSessionId: 'foreign-parent' },
      owner
    )
  ).toBe(false)
  expect(ownsNativeClaudeGatewaySession({ sessionId: 'foreign-root' }, owner)).toBe(false)
})
