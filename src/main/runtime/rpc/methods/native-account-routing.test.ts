import { beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { NATIVE_ACCOUNT_ROUTING_METHODS } from './native-account-routing'

const accountId = '10000000-0000-4000-8000-000000000001'
const control = vi.hoisted(() => ({
  supported: true,
  owned: true,
  adopted: false,
  connected: false
}))
const engine = vi.hoisted(() => ({
  beginGrant: vi.fn(),
  grant: vi.fn(),
  cancelGrant: vi.fn(),
  readConnection: vi.fn((): { adopted: boolean } | null =>
    control.connected ? { adopted: control.adopted } : null
  )
}))
vi.mock('../../runtime-codex-engine-host', () => ({
  supportsCodexEngineGateway: () => control.supported,
  getRuntimeCodexEngineHost: () => {
    if (!control.owned) {
      throw new Error('private diagnostic must not be published')
    }
    return engine
  },
  listRuntimeCodexRoutingAccounts: () => [
    { id: '10000000-0000-4000-8000-000000000001', rosterRevision: 'r1' }
  ]
}))
beforeEach(() => {
  vi.clearAllMocks()
  control.supported = true
  control.owned = true
  control.adopted = false
  control.connected = false
})
function method(name: string) {
  const found = eraseRpcMethods(NATIVE_ACCOUNT_ROUTING_METHODS).find((entry) => entry.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error('Missing unary routing method')
  }
  return found
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers only pass the receiver to mocked host accessors; no runtime method is read.
const runtime = {} as OrcaRuntimeService
const caller = { kind: 'paired-device', deviceId: 'synthetic-phone' } as const

it('reports saved and adopted connections separately without starting sign-in', async () => {
  const read = () => method('accounts.codexRoutingState').handler(undefined, { runtime })
  expect(await read()).toMatchObject({
    supported: true,
    accounts: [{ accountId, rosterRevision: 'r1', status: 'needs-sign-in' }]
  })
  control.connected = true
  expect(await read()).toMatchObject({ accounts: [{ status: 'connected' }] })
  control.adopted = true
  expect(await read()).toMatchObject({ accounts: [{ status: 'ready' }] })
  expect(engine.beginGrant).not.toHaveBeenCalled()
})

it('exposes a safe unavailable reason without leaking host diagnostics', async () => {
  control.owned = false
  expect(await method('accounts.codexRoutingState').handler(undefined, { runtime })).toMatchObject({
    supported: false,
    unavailableReason: 'host-ownership',
    accounts: []
  })
})

it('reports unsupported execution platforms explicitly', async () => {
  control.supported = false
  expect(await method('accounts.codexRoutingState').handler(undefined, { runtime })).toMatchObject({
    supported: false,
    unavailableReason: 'platform'
  })
})

it('binds routing consent to the authenticated caller and existing roster revision', async () => {
  const start = method('accounts.beginCodexRoutingSignIn')
  expect(start.permission).toBe('accounts-admin')
  const params = start.params?.parse({ accountId, expectedRosterRevision: 'r1' })
  await start.handler(params, { runtime, caller })
  expect(engine.beginGrant).toHaveBeenCalledWith('synthetic-phone', {
    accountId,
    expectedRosterRevision: 'r1'
  })
  expect(() =>
    start.params?.parse({ accountId, expectedRosterRevision: 'r1', owner: 'other-phone' })
  ).toThrow()
})

it('refuses anonymous consent before accessing a host or launching anything', () => {
  control.owned = false
  expect(() =>
    method('accounts.beginCodexRoutingSignIn').handler(
      { accountId, expectedRosterRevision: 'r1' },
      { runtime }
    )
  ).toThrow('authenticated caller')
  expect(engine.beginGrant).not.toHaveBeenCalled()
})

it.each([
  ['accounts.codexRoutingSignIn', 'grant'],
  ['accounts.cancelCodexRoutingSignIn', 'cancelGrant']
] as const)('scopes %s to the same caller', async (name, command) => {
  await method(name).handler({ id: accountId }, { runtime, caller })
  expect(engine[command]).toHaveBeenCalledWith('synthetic-phone', accountId)
})
