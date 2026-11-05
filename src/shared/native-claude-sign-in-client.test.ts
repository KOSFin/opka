import { afterEach, expect, it, vi } from 'vitest'
import { runNativeClaudeSignIn, submitNativeClaudeSignInCode } from './native-claude-sign-in-client'

const reference = {
  accountId: '10000000-0000-4000-8000-000000000001',
  signInId: '10000000-0000-4000-8000-000000000002'
}
afterEach(() => vi.useRealTimers())

it('waits for native completion of this attempt without adding another roster account', async () => {
  vi.useFakeTimers()
  const request = vi
    .fn()
    .mockResolvedValueOnce(reference)
    .mockResolvedValueOnce({ state: 'signing-in', link: null })
    .mockResolvedValueOnce({ state: 'ready', link: null })
  const onState = vi.fn()
  const run = runNativeClaudeSignIn({
    request,
    accountId: reference.accountId,
    signal: new AbortController().signal,
    onState
  })
  await vi.advanceTimersByTimeAsync(1000)
  await run
  expect(onState.mock.calls.map(([state]) => state.state)).toEqual(['signing-in', 'ready'])
  expect(request.mock.calls).toEqual([
    ['accounts.beginNativeClaudeRefreshSignIn', { accountId: reference.accountId }],
    ['accounts.getNativeClaudeRefreshSignInLink', reference],
    ['accounts.getNativeClaudeRefreshSignInLink', reference]
  ])
})

it('cancels only its own pending attempt after an aborted late begin', async () => {
  const controller = new AbortController()
  const request = vi.fn().mockImplementation(async () => {
    controller.abort()
    return reference
  })
  const onState = vi.fn()
  await runNativeClaudeSignIn({
    request,
    accountId: reference.accountId,
    signal: controller.signal,
    onState
  })
  expect(onState).not.toHaveBeenCalled()
  expect(request).toHaveBeenLastCalledWith('accounts.cancelNativeClaudeRefreshSignIn', reference)
})

it('stops polling while hidden and cancels its waiter on unmount', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const request = vi.fn().mockResolvedValue(reference)
  const run = runNativeClaudeSignIn({
    request,
    accountId: reference.accountId,
    signal: controller.signal,
    onState: vi.fn(),
    waitUntilActive: (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
  })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(request).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  controller.abort()
  await run
  expect(request).toHaveBeenLastCalledWith('accounts.cancelNativeClaudeRefreshSignIn', reference)
})

it('rejects a foreign account reference without acting on that account', async () => {
  const request = vi.fn().mockResolvedValue({ ...reference, accountId: 'different' })
  await expect(
    runNativeClaudeSignIn({
      request,
      accountId: reference.accountId,
      signal: new AbortController().signal,
      onState: vi.fn()
    })
  ).rejects.toThrow('could not be completed')
  expect(request).toHaveBeenCalledTimes(1)
})

it('never exposes a submitted code in validation or transport errors', async () => {
  const request = vi.fn().mockRejectedValue(new Error('synthetic-code#state'))
  await expect(
    submitNativeClaudeSignInCode(request, reference, 'synthetic-code#state')
  ).rejects.toThrow('Could not confirm the code')
  await expect(submitNativeClaudeSignInCode(request, reference, 'x'.repeat(4097))).rejects.toThrow(
    'Could not confirm the code'
  )
  expect(request).toHaveBeenCalledTimes(1)
})
