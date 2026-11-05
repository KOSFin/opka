import { expect, it } from 'vitest'
import { createClaudeNativePoolHookSettings } from './claude-native-pool-hooks'
const launchId = '00000000-0000-4000-8000-000000000001'
const launch = { command: '/synthetic/opka', args: ['--profile', 'synthetic'] }
it('adds bounded public hook commands without replacing user hooks, MCP or native model settings', () => {
  const managed = createClaudeNativePoolHookSettings(launchId, launch)
  const user = { type: 'command', command: '/synthetic/user-hook' }
  const settings = {
    model: 'haiku',
    mcpServers: { private: { env: { TOKEN: 'fake-private-mcp-token' } } },
    hooks: { Stop: [{ hooks: [user] }] }
  }
  const result = managed.apply(settings)
  expect(result).toMatchObject({ model: settings.model, mcpServers: settings.mcpServers })
  expect(result.hooks.Stop).toContainEqual({ hooks: [user] })
  expect(JSON.stringify(result)).toContain('asyncRewake')
  expect(JSON.stringify(managed.apply(result))).toBe(JSON.stringify(result))
  expect(managed.remove(result)).toMatchObject(settings)
  expect(JSON.stringify(managed.remove(result))).not.toContain('native-pool-hook')
})
it('does not remove a different owned CLI session or a command with different native arguments', () => {
  const first = createClaudeNativePoolHookSettings(launchId, launch)
  const second = createClaudeNativePoolHookSettings('00000000-0000-4000-8000-000000000002', launch)
  const result = first.remove(second.apply({}))
  expect(JSON.stringify(result)).toContain('00000000-0000-4000-8000-000000000002')
})
it('refuses unreadable hook groups rather than discarding native configuration', () => {
  const managed = createClaudeNativePoolHookSettings(launchId, launch)
  expect(() => managed.apply({ hooks: { Stop: 'user-owned-invalid' } })).toThrow('unreadable')
  expect(() => createClaudeNativePoolHookSettings(launchId, { command: 'opka', args: [] })).toThrow(
    'owning host'
  )
})
it('fails closed if the synchronous prompt launcher cannot start, crashes or times out', () => {
  const settings = createClaudeNativePoolHookSettings(launchId, launch).apply({})
  expect(settings).toMatchObject({
    hooks: { UserPromptSubmit: [{ hooks: [{ onFailure: 'block' }, { asyncRewake: true }] }] }
  })
})
