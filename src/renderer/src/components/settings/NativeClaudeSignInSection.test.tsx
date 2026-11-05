// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeClaudeSignInSection } from './NativeClaudeSignInSection'
import type { NativeClaudeSignInView } from '../../../../shared/native-claude-sign-in-client'

const mocks = vi.hoisted(() => ({ run: vi.fn(), submit: vi.fn(), rpc: vi.fn() }))
vi.mock('../../../../shared/native-claude-sign-in-client', () => ({
  runNativeClaudeSignIn: mocks.run,
  submitNativeClaudeSignInCode: mocks.submit
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
const waiting: NativeClaudeSignInView = {
  reference: { accountId: 'existing', signInId: '10000000-0000-4000-8000-000000000002' },
  link: 'https://platform.claude.com/oauth/authorize?state=synthetic&code_challenge=synthetic&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback',
  state: 'signing-in',
  requiresCode: true
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('clears and masks the code immediately, submits once and cancels its own attempt on exit', async () => {
  let signal: AbortSignal | undefined
  mocks.run.mockImplementation(async (options) => {
    signal = options.signal
    options.onState(waiting)
    await new Promise<void>((resolve) =>
      options.signal.addEventListener('abort', () => resolve(), { once: true })
    )
  })
  mocks.submit.mockImplementation(() => new Promise(() => {}))
  const mounted = render(
    <NativeClaudeSignInSection
      target={{ kind: 'local' }}
      accountId="existing"
      onComplete={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Connect for CLI switching' }))
  const input = await screen.findByLabelText('Claude sign-in code')
  expect(input.getAttribute('type')).toBe('password')
  fireEvent.change(input, { target: { value: 'synthetic-code#state' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in code' }))
  expect(input).toMatchObject({ value: '' })
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  expect(mocks.submit).toHaveBeenCalledWith(
    expect.any(Function),
    waiting.reference,
    'synthetic-code#state'
  )
  expect(
    screen.getByRole('button', { name: 'Waiting for confirmation…' }).hasAttribute('disabled')
  ).toBe(true)
  mounted.unmount()
  expect(signal?.aborted).toBe(true)
})

it('reports native completion and never displays raw authentication failures', async () => {
  const onComplete = vi.fn()
  mocks.run.mockImplementationOnce(async (options) =>
    options.onState({ ...waiting, state: 'ready', link: null })
  )
  mocks.run.mockRejectedValueOnce(new Error('private-auth-code'))
  render(
    <NativeClaudeSignInSection
      target={{ kind: 'local' }}
      accountId="existing"
      onComplete={onComplete}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Connect for CLI switching' }))
  await screen.findByRole('button', { name: 'Connect for CLI switching' })
  expect(onComplete).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Connect for CLI switching' }))
  expect((await screen.findByRole('alert')).textContent).toContain('could not be completed')
  expect(screen.queryByText('private-auth-code')).toBeNull()
})
