import { expect, it } from 'vitest'
import { readNativePoolConnectionState } from './native-pool-connection-state'
import { NativeCliShellSetupSchema, nativeCliShellSetupInstalled } from './native-cli-shell-setup'
const setup = { supported: true, state: 'not-installed', missing: ['codex'] } as const
it('normalizes optional reduced setup identically for both providers and keeps older replies valid', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const base =
      provider === 'claude'
        ? { accounts: [] }
        : { accounts: [], capability: 'accounts.native-codex-routing.v1', supported: true }
    expect(
      readNativePoolConnectionState(provider, { ...base, futureSummary: true }).shellSetup
    ).toBeUndefined()
    expect(
      readNativePoolConnectionState(provider, { ...base, shellSetup: setup }).shellSetup
    ).toEqual(setup)
  }
})
it('rejects host paths and arbitrary content in reduced metadata', () => {
  expect(
    NativeCliShellSetupSchema.safeParse({ ...setup, binDirectory: '/private/home' }).success
  ).toBe(false)
  expect(
    NativeCliShellSetupSchema.safeParse({ ...setup, missing: ['/private/home'] }).success
  ).toBe(false)
})

it('requires available native commands and launcher before calling installed setup ready', () => {
  expect(nativeCliShellSetupInstalled({ supported: true, state: 'installed', missing: [] })).toBe(
    true
  )
  expect(
    nativeCliShellSetupInstalled({ supported: true, state: 'installed', missing: ['orca'] })
  ).toBe(false)
  expect(nativeCliShellSetupInstalled({ supported: false, state: 'installed', missing: [] })).toBe(
    false
  )
})
