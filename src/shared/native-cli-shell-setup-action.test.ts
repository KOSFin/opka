import { expect, it, vi } from 'vitest'
import { runNativeCliShellSetupAction } from './native-cli-shell-setup-action'
const installed = { supported: true, state: 'installed', missing: [] }
it('performs exactly one explicit action with a reduced result, without polling', async () => {
  const request = vi.fn(async () => installed),
    signal = new AbortController().signal
  expect(await runNativeCliShellSetupAction({ action: 'install', signal, request })).toEqual(
    installed
  )
  expect(request).toHaveBeenCalledExactlyOnceWith('accounts.installNativeCliIntegration', signal)
})
it('does not retry uncertain delivery or publish raw host errors', async () => {
  const request = vi.fn(async () => {
    throw new Error('/private/host/secret diagnostic')
  })
  await expect(
    runNativeCliShellSetupAction({
      action: 'install',
      signal: new AbortController().signal,
      request
    })
  ).rejects.toThrow('could not be confirmed')
  expect(request).toHaveBeenCalledTimes(1)
})
it('ignores late results after the owning view is canceled', async () => {
  const controller = new AbortController()
  let finish: (value: unknown) => void = () => {}
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = runNativeCliShellSetupAction({
    action: 'uninstall',
    signal: controller.signal,
    request
  })
  controller.abort()
  finish(installed)
  expect(await pending).toBeNull()
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'accounts.uninstallNativeCliIntegration',
    controller.signal
  )
})
it('refuses already-canceled actions and malformed/pathful results', async () => {
  const request = vi.fn(async () => ({ ...installed, binDirectory: '/private/host' }))
  expect(
    await runNativeCliShellSetupAction({ action: 'install', signal: AbortSignal.abort(), request })
  ).toBeNull()
  expect(request).not.toHaveBeenCalled()
  await expect(
    runNativeCliShellSetupAction({
      action: 'install',
      signal: new AbortController().signal,
      request
    })
  ).rejects.toThrow('could not be confirmed')
})
