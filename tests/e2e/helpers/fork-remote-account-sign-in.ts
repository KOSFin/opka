import type { ElectronApplication, Page } from '@stablyai/playwright-test'

export async function installRemoteAccountSignInFixture(
  app: ElectronApplication,
  page: Page
): Promise<void> {
  const environment = {
    id: 'synthetic-sign-in-host',
    name: 'Synthetic server',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'endpoint',
    endpoints: [
      { id: 'endpoint', kind: 'websocket' as const, label: 'Test', endpoint: 'ws://127.0.0.1:1' }
    ]
  }
  await app.evaluate(({ ipcMain }, environment) => {
    ipcMain.removeHandler('runtimeEnvironments:list')
    ipcMain.handle('runtimeEnvironments:list', () => [environment])
    const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers')
    if (!(handlers instanceof Map)) {
      throw new Error('IPC registry unavailable')
    }
    const localCall: unknown = handlers.get('runtime:call')
    if (typeof localCall !== 'function') {
      throw new Error('Runtime IPC handler unavailable')
    }
    const calls: string[] = []
    Reflect.set(ipcMain, 'forkRemoteSignInCalls', calls)
    ipcMain.removeHandler('runtimeEnvironments:call')
    ipcMain.handle('runtimeEnvironments:call', async (event, request) => {
      if (request.selector !== 'synthetic-sign-in-host') {
        throw new Error('Account sign-in reached an unexpected host')
      }
      calls.push(request.method)
      const reply = (result: unknown) => ({ id: 'synthetic-sign-in', ok: true, result })
      if (
        request.method === 'accounts.beginDeviceSignIn' ||
        request.method === 'accounts.deviceSignIn'
      ) {
        return reply({
          id: 'b50321cd-5647-4193-965c-f2cd7c7adb7a',
          provider: 'codex',
          status: 'waiting',
          userCode: 'TEST-CODE1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          expiresAt: Date.now() + 600_000
        })
      }
      if (request.method === 'accounts.cancelDeviceSignIn') {
        return reply({
          id: 'b50321cd-5647-4193-965c-f2cd7c7adb7a',
          provider: 'codex',
          status: 'cancelled',
          expiresAt: Date.now() + 600_000
        })
      }
      if (request.method === 'worktree.list') {
        return reply({
          worktrees: [
            {
              id: 'folder:synthetic-project',
              displayName: 'Server project',
              path: '/synthetic/project'
            },
            {
              id: 'second-workspace',
              displayName: 'Second server project',
              path: '/synthetic/second'
            }
          ]
        })
      }
      // Never start providers, open a browser or create an actual sign-in terminal in this test.
      if (request.method === 'accounts.openSignInTerminal') {
        throw new Error('Synthetic sign-in terminal must not be opened')
      }
      return localCall(event, { method: request.method, params: request.params })
    })
  }, environment)
  await page.evaluate((environment) => {
    window.__store!.getState().setRuntimeEnvironments([environment])
  }, environment)
}

export async function remoteAccountSignInCalls(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(({ ipcMain }) => Reflect.get(ipcMain, 'forkRemoteSignInCalls'))
}
