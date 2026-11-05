import { beforeEach, expect, it, vi } from 'vitest'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
const state = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  available: true
}))
vi.mock('../../configure-native-cli-user-integration', () => ({
  getRuntimeNativeCliUserIntegration: () => (state.available ? state : null)
}))
vi.mock('../../native-cli-account-launch', () => ({
  prepareNativeCliAccountLaunch: vi.fn(),
  releaseNativeCliAccountLaunch: vi.fn()
}))
import { NATIVE_CLI_USER_INTEGRATION_METHODS } from './native-cli-user-integration'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers need only dispatcher metadata and the mocked service lookup, never other runtime methods.
const runtime = { getRuntimeId: () => 'setup-test' } as OrcaRuntimeService
const full = {
  supported: true,
  state: 'installed',
  missing: [],
  binDirectory: '/private/host/bin',
  profileFiles: ['/private/host/.profile']
} as const
beforeEach(() => {
  vi.clearAllMocks()
  state.available = true
  for (const fn of [state.status, state.install, state.uninstall]) {
    fn.mockResolvedValue(full)
  }
})
const methods = eraseRpcMethods(NATIVE_CLI_USER_INTEGRATION_METHODS).filter(
  (method) => !isStreamingMethod(method)
)
for (const method of methods) {
  it(`${method.name} is no-argument accounts-admin`, () => {
    expect(method.params).toBeNull()
    expect(method.permission).toBe('accounts-admin')
  })
  it(`${method.name} fails clearly without a configured host service`, async () => {
    state.available = false
    await expect(
      method.handler(undefined, { runtime, caller: { kind: 'local-cli' } })
    ).rejects.toThrow('Update and restart')
  })
}

for (const method of methods.filter(
  (entry) => entry.name === 'accounts.nativeCliIntegrationStatus'
)) {
  it('retains full reviewable local status and refuses remote path disclosure', async () => {
    expect(await method.handler(undefined, { runtime, caller: { kind: 'local-cli' } })).toEqual(
      full
    )
    for (const clientKind of ['runtime', 'mobile'] as const) {
      await expect(method.handler(undefined, { runtime, clientKind })).rejects.toThrow(
        'owning host local CLI'
      )
    }
  })
}
for (const method of methods.filter(
  (entry) => entry.name !== 'accounts.nativeCliIntegrationStatus'
)) {
  it(`${method.name} accepts authorized paired UI callers and projects no paths`, async () => {
    for (const clientKind of ['runtime', 'mobile'] as const) {
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: NATIVE_CLI_USER_INTEGRATION_METHODS
      })
      const signal = new AbortController().signal
      const result = await dispatcher.dispatch(
        {
          id: clientKind,
          method: method.name,
          authToken: 'test',
          params: { path: '/attacker/chosen', command: 'must not execute' }
        },
        {
          callerScope:
            clientKind === 'mobile' ? { kind: 'mobile' } : { kind: 'runtime-paired', grants: [] },
          clientKind,
          caller: { kind: 'paired-device', deviceId: 'trusted-pair' },
          signal
        }
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.result).toEqual({ supported: true, state: 'installed', missing: [] })
      }
      const called = method.name.includes('uninstall') ? state.uninstall : state.install
      expect(called).toHaveBeenLastCalledWith(signal)
    }
  })
}

it('sanitizes host filesystem errors without weakening local reviewable status', async () => {
  state.install.mockRejectedValue(new Error('/private/host/profile is locked'))
  const dispatcher = new RpcDispatcher({ runtime, methods: NATIVE_CLI_USER_INTEGRATION_METHODS })
  const result = await dispatcher.dispatch(
    { id: 'error', method: 'accounts.installNativeCliIntegration', authToken: 'test' },
    {
      callerScope: { kind: 'runtime-paired', grants: [] },
      clientKind: 'runtime',
      caller: { kind: 'paired-device', deviceId: 'trusted-pair' }
    }
  )
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.message).not.toContain('/private/')
    expect(result.error.message).toContain('needs review')
  }
})
