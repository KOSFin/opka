import { writeFile } from 'node:fs/promises'
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

async function captureHiddenRenderer(page: Page, path: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false
    })
    await writeFile(path, Buffer.from(data, 'base64'))
  } finally {
    await cdp.detach()
  }
}

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
      ipcMain.removeHandler('codexAccounts:list')
      ipcMain.handle('codexAccounts:list', () => ({
        accounts: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            email: 'pool@example.test',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeAccountId: '10000000-0000-4000-8000-000000000001'
      }))
      let policy = {
        id: 'codex-default',
        provider: 'codex',
        revision: 3,
        strategy: 'sequential',
        applyToNewWork: true,
        rotation: 'on-limit',
        unknownQuota: 'exclude',
        allowReserve: false,
        members: [
          {
            accountId: '10000000-0000-4000-8000-000000000001',
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
          if (request.method === 'accounts.codexRoutingState') {
            return {
              id: 'synthetic-routing',
              ok: true,
              result: {
                capability: 'accounts.native-codex-routing.v1',
                supported: true,
                accounts: [
                  {
                    accountId: '10000000-0000-4000-8000-000000000001',
                    rosterRevision: 'synthetic-revision',
                    status: 'ready'
                  }
                ]
              }
            }
          }
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
                    accounts: [
                      { id: '10000000-0000-4000-8000-000000000001', email: 'pool@example.test' }
                    ],
                    activeAccountId: '10000000-0000-4000-8000-000000000001'
                  }
                },
                candidates: [
                  {
                    provider: 'codex',
                    accountId: '10000000-0000-4000-8000-000000000001',
                    auth: 'ready',
                    quota: 'unknown',
                    usedPercent: null
                  }
                ],
                assignments: [
                  {
                    ownerKey: 'synthetic-owner',
                    provider: 'codex',
                    accountId: '10000000-0000-4000-8000-000000000001',
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
    const provider = launched.page.locator('[data-provider-accounts="Codex"]')
    await provider.getByRole('button', { name: 'Codex', exact: true }).click()
    await expect(provider.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    const section = provider.locator('#accounts-codex-switching')
    const account = section.getByRole('group', { name: 'pool@example.test' })
    await expect(account.getByText('pool@example.test', { exact: true })).toHaveCount(1)
    await expect(account.getByRole('button', { name: 'Use for new chats' })).toBeDisabled()
    await expect(account.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled()
    await expect(section.getByText(/Auth: ready · Quota: unknown/)).toBeVisible()
    await expect(section.getByText('CLI switching ready', { exact: true })).toBeVisible()
    await expect(section.getByRole('switch', { name: 'Use automatic pool' })).toBeChecked()
    await captureHiddenRenderer(launched.page, info.outputPath('account-pool-settings-before.png'))
    await section.getByRole('combobox', { name: 'codex pool mode' }).click()
    await launched.page.getByRole('option', { name: 'Balanced', exact: true }).click()
    await section.getByRole('spinbutton', { name: 'pool@example.test priority' }).fill('2')
    await section.getByRole('combobox', { name: 'pool@example.test pool participation' }).click()
    await launched.page.getByRole('option', { name: 'Drain', exact: true }).click()
    await section.getByRole('button', { name: 'Save Codex settings' }).click()
    await expect(section.getByText(/Codex pool saved on/)).toBeVisible()
    await expect(section.getByRole('combobox', { name: 'codex pool mode' })).toHaveText('Balanced')
    await expect(
      section.getByRole('spinbutton', { name: 'pool@example.test priority' })
    ).toHaveValue('2')
    await expect(
      section.getByRole('combobox', { name: 'pool@example.test pool participation' })
    ).toHaveText('Drain')
    await captureHiddenRenderer(launched.page, info.outputPath('account-pool-settings.png'))
    await launched.page.setViewportSize({ width: 720, height: 900 })
    await expect(section.getByRole('button', { name: 'Save Codex settings' })).toBeVisible()
    await expect(
      section.getByRole('spinbutton', { name: 'pool@example.test priority' })
    ).toHaveValue('2')
    await captureHiddenRenderer(launched.page, info.outputPath('account-pool-settings-narrow.png'))
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
    const provider = launched.page.locator('[data-provider-accounts="Codex"]')
    await provider.getByRole('button', { name: 'Codex', exact: true }).click()
    await expect(provider.locator('#accounts-codex-switching').getByRole('alert')).toContainText(
      'Account pools unavailable'
    )
    await expect(launched.page.getByRole('button', { name: 'Save Codex settings' })).toHaveCount(0)
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
    await installRemoteAccountSignInFixture(app, launched.page, {
      id: '10000000-0000-4000-8000-000000000001',
      email: 'pool@example.test',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })
    await launched.page.getByRole('combobox', { name: 'Host', exact: true }).click()
    await launched.page.getByRole('option', { name: 'Synthetic server', exact: true }).click()
    const codexProvider = launched.page.locator('[data-provider-accounts="Codex"]')
    await codexProvider.getByRole('button', { name: 'Codex', exact: true }).click()
    const signIn = codexProvider.getByRole('region', { name: 'Server account sign-in' })
    await expect(signIn.getByText(/Sign in for Synthetic server/)).toBeVisible()
    await expect(
      codexProvider
        .locator('#accounts-codex-switching')
        .getByRole('group', { name: 'pool@example.test' })
    ).toBeVisible()
    await expect(
      launched.page.getByText('Could not load provider accounts.', { exact: true })
    ).toHaveCount(0)
    await signIn.getByRole('button', { name: 'Add Codex account', exact: true }).click()
    await expect(signIn.getByText('TEST-CODE1', { exact: true })).toBeVisible()
    await expect(signIn.getByRole('button', { name: 'Open sign-in page' })).toBeVisible()
    await captureHiddenRenderer(launched.page, info.outputPath('remote-codex-account-code.png'))
    await signIn.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
    await expect(signIn.getByText('TEST-CODE1', { exact: true })).toHaveCount(0)
    await expect.poll(() => remoteAccountSignInCalls(app!)).toContain('accounts.cancelDeviceSignIn')
    const claudeProvider = launched.page.locator('[data-provider-accounts="Claude"]')
    await claudeProvider.getByRole('button', { name: 'Claude', exact: true }).click()
    await claudeProvider.getByRole('button', { name: 'Add Claude account in terminal' }).click()
    await claudeProvider.getByRole('combobox', { name: 'Claude sign-in workspace' }).click()
    await launched.page.getByRole('option', { name: 'Second server project', exact: true }).click()
    await expect(
      claudeProvider.getByRole('combobox', { name: 'Claude sign-in workspace' })
    ).toHaveText('Second server project')
    await expect(
      claudeProvider.getByRole('button', { name: 'Open Claude sign-in', exact: true })
    ).toBeEnabled()
    await captureHiddenRenderer(
      launched.page,
      info.outputPath('remote-claude-account-workspace.png')
    )
  } finally {
    await session.dispose(app)
  }
})
