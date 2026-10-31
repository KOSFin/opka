import { afterEach, describe, expect, it, vi } from 'vitest'
afterEach(() => vi.useRealTimers())
import { AccountDeviceSignIns } from './account-device-sign-in'
import type { CodexDeviceAuthorization } from '../../shared/account-device-sign-in'

function harness() {
  let prompt: ((value: CodexDeviceAuthorization) => void) | undefined
  let signal: AbortSignal | undefined
  let resolve: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const start = vi.fn(
    (onPrompt: (value: CodexDeviceAuthorization) => void, nextSignal: AbortSignal) => {
      prompt = onPrompt
      signal = nextSignal
      return new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      })
    }
  )
  return {
    manager: new AccountDeviceSignIns(start),
    start,
    prompt: () => prompt,
    signal: () => signal,
    resolve: () => resolve?.(),
    reject: (error: Error) => reject?.(error)
  }
}
const tick = async () => {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve()
  }
}

describe('host-owned device sign-in', () => {
  it('keeps a pending enrollment across reconnects but hides it from another paired device', async () => {
    const h = harness()
    const first = h.manager.begin('phone-a')
    await tick()
    expect(h.manager.begin('phone-a').id).toBe(first.id)
    expect(h.start).toHaveBeenCalledOnce()
    expect(() => h.manager.get('phone-b', first.id)).toThrow('not available')
    expect(() => h.manager.cancel('phone-b', first.id)).toThrow('not available')
    expect(() => h.manager.begin('phone-b')).toThrow('Another device')
    expect(h.signal()?.aborted).toBe(false)
  })
  it('publishes the code while waiting and removes it after managed registration completes', async () => {
    const h = harness()
    const first = h.manager.begin('desktop')
    await tick()
    h.prompt()?.({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'AB12-CDE34'
    })
    expect(h.manager.get('desktop', first.id).status).toBe('waiting')
    h.resolve()
    await tick()
    expect(h.manager.get('desktop', first.id)).toMatchObject({ status: 'complete' })
    expect(h.manager.get('desktop', first.id).userCode).toBeUndefined()
    expect(h.manager.begin('phone').id).not.toBe(first.id)
  })
  it('cancels only the enrolled process and sanitizes provider output', async () => {
    const h = harness()
    const first = h.manager.begin('desktop')
    await tick()
    h.manager.cancel('desktop', first.id)
    expect(h.signal()?.aborted).toBe(true)
    h.reject(new Error('cancelled secret-code'))
    await tick()
    expect(h.manager.get('desktop', first.id)).toMatchObject({ status: 'cancelled' })
    expect(h.manager.get('desktop', first.id).error).not.toContain('secret-code')
  })
  it('handles synchronous launch refusal without leaving a permanently starting session', async () => {
    const manager = new AccountDeviceSignIns(() => {
      throw new Error('private path')
    })
    const first = manager.begin('phone')
    await tick()
    expect(manager.get('phone', first.id)).toMatchObject({ status: 'failed' })
    expect(manager.get('phone', first.id).error).not.toContain('private path')
  })
  it('blocks retries until cancellation unwinds and drops late provider prompts', async () => {
    const h = harness()
    const first = h.manager.begin('desktop')
    await tick()
    h.prompt()?.({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'AB12-CDE34'
    })
    expect(h.manager.cancel('desktop', first.id)).toMatchObject({ status: 'cancelled' })
    expect(() => h.manager.begin('desktop')).toThrow('previous sign-in is closing')
    h.prompt()?.({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'XY12-ABCDE'
    })
    expect(h.manager.get('desktop', first.id).userCode).toBeUndefined()
    h.reject(new Error('cancelled'))
    await tick()
    expect(h.manager.begin('desktop').id).not.toBe(first.id)
  })
  it('expires an operation even if no prompt is ever published', async () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.manager.begin('phone')
    await tick()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(h.signal()?.aborted).toBe(true)
    expect(h.manager.get('phone', first.id)).toMatchObject({
      status: 'failed',
      error: 'Codex sign-in expired. Start a new sign-in.'
    })
    h.reject(new Error('cancelled'))
    await tick()
    expect(h.manager.get('phone', first.id).status).toBe('failed')
  })
  it('shutdown waits for cleanup and refuses future starts', async () => {
    const h = harness()
    h.manager.begin('desktop')
    await tick()
    const stopped = h.manager.stop()
    expect(h.signal()?.aborted).toBe(true)
    expect(() => h.manager.begin('desktop')).toThrow('shutting down')
    h.reject(new Error('cancelled'))
    await stopped
  })
  it('keeps a successful registration when cancellation loses the provider-auth race', async () => {
    const h = harness()
    const first = h.manager.begin('desktop')
    await tick()
    h.manager.cancel('desktop', first.id)
    h.resolve()
    await tick()
    expect(h.manager.get('desktop', first.id)).toMatchObject({ status: 'complete' })
  })
})
