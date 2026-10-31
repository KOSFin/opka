import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAccountDeviceSignIn } from './account-device-sign-in-client'

const id = '8f69d4a3-1b39-4ed0-9d86-25d160e7396b'
const starting = { id, provider: 'codex', status: 'starting', expiresAt: 100_000 }
afterEach(() => vi.useRealTimers())

describe('account enrollment client', () => {
  it('publishes the code and finishes only after the host confirms registration', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockResolvedValueOnce(starting)
      .mockResolvedValueOnce({
        ...starting,
        status: 'waiting',
        userCode: 'AB12-CD345',
        verificationUrl: 'https://auth.openai.com/codex/device'
      })
      .mockResolvedValueOnce({ ...starting, status: 'complete' })
    const onState = vi.fn()
    const work = runAccountDeviceSignIn({ request, onState, signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(2000)
    await work
    expect(onState.mock.calls.map(([state]) => state.status)).toEqual([
      'starting',
      'waiting',
      'complete'
    ])
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('cancels a pending host response after the caller has left the host', async () => {
    let finish: (value: unknown) => void = () => undefined
    const begin = new Promise((resolve) => {
      finish = resolve
    })
    const request = vi.fn().mockReturnValueOnce(begin).mockResolvedValue({})
    const controller = new AbortController()
    const onState = vi.fn()
    const work = runAccountDeviceSignIn({ request, onState, signal: controller.signal })
    controller.abort()
    finish(starting)
    await work
    expect(onState).not.toHaveBeenCalled()
    expect(request).toHaveBeenLastCalledWith('accounts.cancelDeviceSignIn', { id })
  })

  it('rejects an unexpected authorization site instead of opening it', async () => {
    const request = vi.fn().mockResolvedValue({
      ...starting,
      status: 'waiting',
      verificationUrl: 'https://example.com',
      userCode: 'AB12-CD345'
    })
    const onState = vi.fn()
    await expect(
      runAccountDeviceSignIn({ request, onState, signal: new AbortController().signal })
    ).rejects.toThrow()
    expect(onState).not.toHaveBeenCalled()
  })
})
