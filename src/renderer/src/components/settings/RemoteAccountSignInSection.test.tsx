// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteAccountSignInSection } from './RemoteAccountSignInSection'

vi.mock('./RemoteClaudeSignInSection', () => ({ RemoteClaudeSignInSection: () => null }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{host}}', values?.host ?? '')
}))
const waiting = {
  id: 'b50321cd-5647-4193-965c-f2cd7c7adb7a',
  provider: 'codex',
  status: 'waiting',
  userCode: 'AB12-CD345',
  verificationUrl: 'https://auth.openai.com/codex/device',
  expiresAt: 2_000_000_000_000
} as const
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('starts on the chosen server and removes its code when cancelled', async () => {
  rpc.mockResolvedValue(waiting)
  const target = { kind: 'environment', environmentId: 'server-one' } as const
  const onComplete = vi.fn()
  render(
    <RemoteAccountSignInSection target={target} hostLabel="Server one" onComplete={onComplete} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add Codex account' }))
  await screen.findByText(waiting.userCode)
  expect(rpc).toHaveBeenCalledWith(target, 'accounts.beginDeviceSignIn', { provider: 'codex' })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(target, 'accounts.cancelDeviceSignIn', { id: waiting.id })
  )
  expect(screen.queryByText(waiting.userCode)).toBeNull()
  expect(onComplete).not.toHaveBeenCalled()
})

it('ignores an old host response after the section is replaced', async () => {
  let reply: (value: unknown) => void = () => undefined
  rpc
    .mockReturnValueOnce(
      new Promise((resolve) => {
        reply = resolve
      })
    )
    .mockResolvedValue(waiting)
  const onComplete = vi.fn()
  const first = render(
    <RemoteAccountSignInSection
      target={{ kind: 'environment', environmentId: 'old' }}
      hostLabel="Old"
      onComplete={onComplete}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add Codex account' }))
  first.unmount()
  render(
    <RemoteAccountSignInSection
      target={{ kind: 'environment', environmentId: 'new' }}
      hostLabel="New"
      onComplete={onComplete}
    />
  )
  reply(waiting)
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'old' },
      'accounts.cancelDeviceSignIn',
      { id: waiting.id }
    )
  )
  expect(screen.queryByText(waiting.userCode)).toBeNull()
  expect(onComplete).not.toHaveBeenCalled()
})
