import { expect, it } from 'vitest'
import { nativeAgentNeedsAccount } from './native-agent-account-command'
it.each([
  '--mcp-config',
  '--settings',
  '--model',
  '--permission-mode',
  '--plugin-dir',
  '--add-dir'
])('keeps Claude %s values from being mistaken for auth subcommands', (option) => {
  expect(nativeAgentNeedsAccount('claude', [option, 'login'])).toBe(true)
})
it.each(['--enable', '--image', '--add-dir', '--model', '--config'])(
  'uses the existing Codex global flag arity for %s',
  (option) => {
    expect(nativeAgentNeedsAccount('codex', [option, 'auth'])).toBe(true)
  }
)
it('preserves explicit native auth discovery and help without broker admission', () => {
  expect(nativeAgentNeedsAccount('claude', ['auth', 'status'])).toBe(false)
  expect(
    nativeAgentNeedsAccount('claude', ['--settings', '/synthetic/settings', 'auth', 'login'])
  ).toBe(false)
  expect(nativeAgentNeedsAccount('codex', ['--profile', 'synthetic', 'login'])).toBe(false)
  expect(nativeAgentNeedsAccount('claude', ['--', 'auth'])).toBe(true)
})

it.each(['auth', 'login', 'mcp', 'plugin', 'config'])(
  'admits Claude print prompt %s as inference',
  (prompt) => {
    expect(nativeAgentNeedsAccount('claude', ['-p', prompt])).toBe(true)
    expect(nativeAgentNeedsAccount('claude', ['--print', prompt])).toBe(true)
    expect(nativeAgentNeedsAccount('claude', ['--', prompt])).toBe(true)
  }
)
it.each(['mcp', 'plugin', 'config', 'install', 'setup-token'])(
  'keeps Claude %s management offline',
  (command) => {
    expect(nativeAgentNeedsAccount('claude', [command, 'list'])).toBe(false)
    expect(nativeAgentNeedsAccount('claude', ['--model', command])).toBe(true)
  }
)

it('keeps native remote connections outside this host pool without treating option values as connections', () => {
  expect(nativeAgentNeedsAccount('codex', ['--remote', 'auth'])).toBe(false)
  expect(nativeAgentNeedsAccount('codex', ['--remote=http://example.invalid'])).toBe(false)
  expect(nativeAgentNeedsAccount('codex', ['--config', '--remote=literal'])).toBe(true)
  expect(nativeAgentNeedsAccount('codex', ['--', '--remote=literal'])).toBe(true)
})
