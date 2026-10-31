import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcRefusal, rpcSuccess } from '../transport/rpc-operation-test-families'
import {
  accountPoolUpdate,
  accountSignInWorkspacesRead,
  mobileAccountDeviceSignInRequest,
  openMobileAccountSignInTerminal
} from './mobile-account-enrollment-operations'

const id = 'c8083a56-bd6a-43d6-b3b9-a9b80402d274'
const state = { id, provider: 'codex', status: 'starting', expiresAt: 1234 }

describe('mobile account enrollment operations', () => {
  it('dispatches only the three supported device methods with checked params and replies', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(rpcSuccess(state))
    const request = mobileAccountDeviceSignInRequest(client)
    await expect(request('accounts.beginDeviceSignIn', { provider: 'codex' })).resolves.toEqual(
      state
    )
    await expect(request('accounts.deviceSignIn', { id })).resolves.toEqual(state)
    await expect(request('accounts.cancelDeviceSignIn', { id })).resolves.toEqual(state)
    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    await expect(request('terminal.send', { id })).rejects.toThrow('Unsupported')
    await expect(request('accounts.deviceSignIn', { provider: 'codex' })).rejects.toThrow()
    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    client.sendRequest.mockResolvedValue(rpcSuccess({ id }))
    await expect(request('accounts.deviceSignIn', { id })).rejects.toThrow()
  })

  it('keeps host refusal visible and rejects terminal replies without navigable pane ids', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValueOnce(rpcRefusal('unavailable', 'Host unavailable'))
    await expect(
      mobileAccountDeviceSignInRequest(client)('accounts.deviceSignIn', { id })
    ).rejects.toThrow('Host unavailable')
    client.sendRequest.mockResolvedValueOnce(rpcSuccess({ terminal: { handle: 'one' } }))
    await expect(
      openMobileAccountSignInTerminal(client, {
        provider: 'claude',
        worktree: 'folder:/project',
        clientMutationId: 'one'
      })
    ).rejects.toThrow()
  })

  it('validates workspace inventory but permits unread mutation acknowledgements', async () => {
    expect(() => accountSignInWorkspacesRead.interpret(rpcSuccess({ worktrees: [{}] }))).toThrow()
    expect(accountPoolUpdate.interpret(rpcSuccess(undefined))).toBeUndefined()
  })
})
