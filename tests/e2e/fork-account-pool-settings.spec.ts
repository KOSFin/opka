import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import {
  installRemoteAccountSignInFixture,
  remoteAccountSignInCalls
} from './helpers/fork-remote-account-sign-in'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit isolated background Electron required')
test.use({ trace: 'off', screenshot: 'off' })

async function openPools(app: ElectronApplication, page: Page, unsupported = false): Promise<void> {
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await app.evaluate(
    ({ ipcMain }, { unsupported }) => {
      const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers')
      if (!(handlers instanceof Map)) {
        throw new Error('Runtime IPC handler registry unavailable')
      }
      const originalCall: unknown = handlers.get('runtime:call')
      if (typeof originalCall !== 'function') {
        throw new Error('Runtime IPC handler missing')
      }
      let policy = {
        id: 'codex-default',
        provider: 'codex',
        revision: 3,
        strategy: 'sequential',
        unknownQuota: 'exclude',
        allowReserve: false,
        members: [
          {
            accountId: 'synthetic-account',
            priority: 7,
            weight: 1,
            maxConcurrent: 1,
            state: 'enabled',
            role: 'primary'
          }
        ]
      }
      ipcMain.removeHandler('runtime:call')
      ipcMain.handle(
        'runtime:call',
        async (event, request: { method: string; params?: unknown }) => {
          if (request.method === 'accountPool.list') {
            if (unsupported) {
              return {
                id: 'synthetic',
                ok: false,
                error: { code: 'unknown_method', message: 'Unknown method accountPool.list' }
              }
            }
            return {
              id: 'synthetic',
              _meta: { runtimeId: 'synthetic-host' },
              ok: true,
              result: {
                capability: 'orchestration.account-pools.v1',
                policies: [policy],
                accounts: {
                  claude: { accounts: [], activeAccountId: null },
                  codex: {
                    accounts: [{ id: 'synthetic-account', email: 'pool@example.test' }],
                    activeAccountId: 'synthetic-account'
                  }
                },
                candidates: [
                  {
                    provider: 'codex',
                    accountId: 'synthetic-account',
                    auth: 'ready',
                    quota: 'unknown',
                    usedPercent: null
                  }
                ],
                assignments: [
                  {
                    ownerKey: 'synthetic-owner',
                    provider: 'codex',
                    accountId: 'synthetic-account',
                    poolId: 'codex-default',
                    state: 'ready'
                  }
                ]
              }
            }
          }
          if (request.method === 'accountPool.update') {
            const params = request.params
            if (
              params &&
              typeof params === 'object' &&
              'policy' in params &&
              'expectedRevision' in params
            ) {
              const candidate = params.policy
              if (
                candidate &&
                typeof candidate === 'object' &&
                'id' in candidate &&
                candidate.id === policy.id
              ) {
                const next = JSON.parse(JSON.stringify(candidate))
                if (params.expectedRevision !== policy.revision) {
                  return {
                    id: 'synthetic',
                    ok: false,
                    error: {
                      code: 'conflict',
                      message: 'Account pool changed; reload before saving'
                    }
                  }
                }
                policy = { ...next, revision: policy.revision + 1 }
                return {
                  id: 'synthetic',
                  _meta: { runtimeId: 'synthetic-host' },
                  ok: true,
                  result: policy
                }
              }
            }
            return {
              id: 'synthetic',
              ok: false,
              error: { code: 'invalid_params', message: 'Invalid pool' }
            }
          }
          return originalCall(event, request)
        }
      )
    },
    { unsupported }
  )
  const probe = await page.evaluate(() => window.api.runtime.call({ method: 'accountPool.list' }))
  expect(probe.ok).toBe(!unsupported)
  expect(probe.id).toBe('synthetic')
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'accounts', repoId: null })
    state.openSettingsPage()
  })
}

test('pool operator edits real controls and reads the host-confirmed revision', async ({
  testRepoPath
}, info) => {
  expect(testRepoPath).toBeTruthy()
  const session = createRestartSession(info, { ORCA_BACKGROUND_LAUNCH: '1' })
  let app: ElectronApplication | undefined
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    await openPools(app, launched.page)
    const section = launched.page.locator('#account-pools')
    await expect(section.getByText('pool@example.test · Selected login')).toBeVisible()
    await expect(section.getByText(/Auth: ready · Quota: unknown/)).toBeVisible()
    await launched.page.screenshot({ path: info.outputPath('account-pool-settings-before.png') })
    await section.getByRole('combobox', { name: 'codex pool mode' }).click()
    await launched.page.getByRole('option', { name: 'Balanced', exact: true }).click()
    await section.getByRole('spinbutton', { name: 'pool@example.test priority' }).fill('2')
    await section.getByRole('combobox', { name: 'pool@example.test pool participation' }).click()
    await launched.page.getByRole('option', { name: 'Drain', exact: true }).click()
    await section.getByRole('button', { name: 'Save codex pool' }).click()
    await expect(section.getByText(/Pool saved on/)).toBeVisible()
    await expect(section.getByRole('combobox', { name: 'codex pool mode' })).toHaveText('Balanced')
    await expect(
      section.getByRole('spinbutton', { name: 'pool@example.test priority' })
    ).toHaveValue('2')
    await expect(
      section.getByRole('combobox', { name: 'pool@example.test pool participation' })
    ).toHaveText('Drain')
    await launched.page.screenshot({ path: info.outputPath('account-pool-settings.png') })
  } finally {
    await session.dispose(app)
  }
})

test('older hosts expose an unavailable state without mutation controls', async ({
  testRepoPath
}, info) => {
  expect(testRepoPath).toBeTruthy()
  const session = createRestartSession(info, { ORCA_BACKGROUND_LAUNCH: '1' })
  let app: ElectronApplication | undefined
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    await openPools(app, launched.page, true)
    await expect(launched.page.locator('#account-pools').getByRole('alert')).toContainText(
      'Account pools unavailable'
    )
    await expect(launched.page.getByRole('button', { name: 'Save codex pool' })).toHaveCount(0)
  } finally {
    await session.dispose(app)
  }
})

test('server accounts show device sign-in, cancel safely and choose a Claude workspace', async ({
  testRepoPath
}, info) => {
  expect(testRepoPath).toBeTruthy()
  const session = createRestartSession(info, { ORCA_BACKGROUND_LAUNCH: '1' })
  let app: ElectronApplication | undefined
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    await openPools(app, launched.page)
    await installRemoteAccountSignInFixture(app, launched.page)
    await launched.page.getByRole('combobox', { name: 'Host', exact: true }).click()
    await launched.page.getByRole('option', { name: 'Synthetic server', exact: true }).click()
    const signIn = launched.page.getByRole('region', { name: 'Server account sign-in' })
    await expect(signIn.getByText(/Sign in for Synthetic server/)).toBeVisible()
    await expect(
      launched.page.locator('#account-pools').getByText('pool@example.test · Selected login')
    ).toBeVisible()
    await expect(
      launched.page.getByText('Could not load provider accounts.', { exact: true })
    ).toHaveCount(0)
    await signIn.getByRole('button', { name: 'Add Codex account', exact: true }).click()
    await expect(signIn.getByText('TEST-CODE1', { exact: true })).toBeVisible()
    await expect(signIn.getByRole('button', { name: 'Open sign-in page' })).toBeVisible()
    await launched.page.screenshot({ path: info.outputPath('remote-codex-account-code.png') })
    await signIn.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
    await expect(signIn.getByText('TEST-CODE1', { exact: true })).toHaveCount(0)
    await expect.poll(() => remoteAccountSignInCalls(app!)).toContain('accounts.cancelDeviceSignIn')
    await signIn.getByRole('button', { name: 'Add Claude account in terminal' }).click()
    await signIn.getByRole('combobox', { name: 'Claude sign-in workspace' }).click()
    await launched.page.getByRole('option', { name: 'Second server project', exact: true }).click()
    await expect(signIn.getByRole('combobox', { name: 'Claude sign-in workspace' })).toHaveText(
      'Second server project'
    )
    await expect(
      signIn.getByRole('button', { name: 'Open Claude sign-in', exact: true })
    ).toBeEnabled()
    await launched.page.screenshot({ path: info.outputPath('remote-claude-account-workspace.png') })
  } finally {
    await session.dispose(app)
  }
})
