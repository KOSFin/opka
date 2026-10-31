import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { ACCOUNT_DEVICE_SIGN_IN_METHODS } from './account-device-sign-in'

const id = 'e54a2953-21c9-44d5-8c34-28516919877c'
function method(name: string) {
  const method = eraseRpcMethods(ACCOUNT_DEVICE_SIGN_IN_METHODS).find(
    (entry) => entry.name === name
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing unary sign-in method')
  }
  return method
}

describe('paired account device sign-in RPC', () => {
  it('binds an enrollment to the authenticated device subject instead of request fields', async () => {
    const beginDeviceSignIn = vi.fn(() => ({ id }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler only invokes the one supplied command.
    const runtime = { beginDeviceSignIn } as unknown as OrcaRuntimeService
    const start = method('accounts.beginDeviceSignIn')
    expect(start.permission).toBe('accounts-admin')
    const params = start.params?.parse({ provider: 'codex' })
    await start.handler(params, {
      runtime,
      clientKind: 'mobile',
      caller: { kind: 'paired-device', deviceId: 'phone-a' }
    })
    expect(beginDeviceSignIn).toHaveBeenCalledExactlyOnceWith('phone-a')
    expect(() => start.params?.parse({ provider: 'codex', owner: 'phone-b' })).toThrow()
    expect(() => start.params?.parse({ provider: 'claude' })).toThrow()
  })
  it('refuses anonymous callers before any launch', async () => {
    const beginDeviceSignIn = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refusal occurs before the stub can be invoked.
    const runtime = { beginDeviceSignIn } as unknown as OrcaRuntimeService
    expect(() =>
      method('accounts.beginDeviceSignIn').handler(
        { provider: 'codex' },
        { runtime, clientKind: 'runtime' }
      )
    ).toThrow('authenticated caller')
    expect(beginDeviceSignIn).not.toHaveBeenCalled()
  })
  it.each([
    ['accounts.deviceSignIn', 'deviceSignIn'],
    ['accounts.cancelDeviceSignIn', 'cancelDeviceSignIn']
  ] as const)('passes only its owner and enrollment id to %s', async (name, command) => {
    const call = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selected handler invokes only this computed command.
    const runtime = { [command]: call } as unknown as OrcaRuntimeService
    await method(name).handler(
      { id },
      { runtime, caller: { kind: 'paired-device', deviceId: 'desktop-b' } }
    )
    expect(call).toHaveBeenCalledExactlyOnceWith('desktop-b', id)
  })
})
