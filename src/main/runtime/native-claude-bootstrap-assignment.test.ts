import { expect, it } from 'vitest'
import { isNativeClaudeBootstrapOwner } from './native-claude-bootstrap-assignment'
it('accepts only the terminal creator namespace, never retained native scopes or malformed hints', () => {
  expect(isNativeClaudeBootstrapOwner('pty:11111111-1111-4111-8111-111111111111')).toBe(true)
  for (const owner of [
    'native-cli:11111111-1111-4111-8111-111111111111',
    'native-scope-v2:claude:1:11111111-1111-4111-8111-111111111111:1',
    'native-scope-v1:retained',
    'native-scope-v2:malformed',
    'pty:unknown',
    'worker:unknown'
  ]) {
    expect(isNativeClaudeBootstrapOwner(owner)).toBe(false)
  }
})
