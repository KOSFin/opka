import { expect, it, vi } from 'vitest'
import { claudeNativeSourceEnvironment } from './claude-native-source-environment'

it('retains the trusted native user domain only on Darwin and keeps the explicit source', () => {
  expect(claudeNativeSourceEnvironment('/owned/account', '/native/user', 'darwin')).toEqual({
    HOME: '/native/user',
    CLAUDE_CONFIG_DIR: '/owned/account'
  })
  expect(claudeNativeSourceEnvironment('/owned/account', '/native/user', 'linux')).toEqual({
    HOME: '/owned',
    CLAUDE_CONFIG_DIR: '/owned/account'
  })
})

it.each([undefined, '', 'relative', '/invalid\0home'])(
  'refuses missing or invalid Darwin user domain %s',
  (home) => {
    expect(() => claudeNativeSourceEnvironment('/owned/account', home, 'darwin')).toThrow(
      'user domain'
    )
  }
)

it('requires a trusted absolute source directory on every platform', () => {
  expect(() => claudeNativeSourceEnvironment('relative', '/native/user', 'darwin')).toThrow(
    'configuration'
  )
  expect(() => claudeNativeSourceEnvironment('/invalid\0source', undefined, 'linux')).toThrow(
    'configuration'
  )
})

it('rejects invalid source before reserving a writer or launching login/refresh', async () => {
  const { refreshClaudeNativeAccess } = await import('./claude-native-refresh-authority')
  const { runClaudeNativeSourceLogin } = await import('./claude-native-source-login')
  const assertExclusive = vi.fn()
  const reserve = vi.fn()
  const run = vi.fn()
  expect(() =>
    refreshClaudeNativeAccess(
      {
        configDir: 'relative',
        writerDirectory: '/owned/writer',
        qualifiedVersion: '2.1.318',
        expectedIdentity: {
          accountUuid: 'fake',
          organizationUuid: 'fake',
          emailAddress: 'fake@example.invalid'
        },
        launch: { command: '/fake/claude', args: [] },
        assertExclusive
      },
      { reserve, run }
    )
  ).toThrow('configuration')
  await expect(
    runClaudeNativeSourceLogin({
      home: 'relative',
      writerDirectory: '/owned/writer',
      launch: { command: '/fake/claude', args: [] },
      assertExclusive
    })
  ).rejects.toThrow('configuration')
  expect(reserve).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(assertExclusive).not.toHaveBeenCalled()
})
