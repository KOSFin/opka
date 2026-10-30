import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit isolated background Electron required')
test.use({ trace: 'off', screenshot: 'off' })

async function openPools(page: Page, unsupported = false): Promise<void> {
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await page.evaluate(
    ({ unsupported }) => {
      const originalCall = window.api.runtime.call
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
      window.api.runtime.call = async (request) => {
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
                  error: { code: 'conflict', message: 'Account pool changed; reload before saving' }
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
        return originalCall(request)
      }
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'accounts', repoId: null })
      state.openSettingsPage()
    },
    { unsupported }
  )
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
    await openPools(launched.page)
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
    await openPools(launched.page, true)
    await expect(launched.page.locator('#account-pools').getByRole('alert')).toContainText(
      'Account pools unavailable'
    )
    await expect(launched.page.getByRole('button', { name: 'Save codex pool' })).toHaveCount(0)
  } finally {
    await session.dispose(app)
  }
})
