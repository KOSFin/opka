import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AccountPoolViewSchema, type AccountPoolView } from '../../src/shared/account-pool-view'
import { expect, test } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' }, trace: 'off', screenshot: 'off' })

const responsePath = process.env.ORCA_QUOTA_REVIEW_RESPONSE_PATH
const screenshotDir = process.env.ORCA_QUOTA_REVIEW_SCREENSHOT_DIR
test.skip(
  !responsePath || !screenshotDir,
  'Synthetic host receipt and screenshot directory required'
)

function hostResponse(): AccountPoolView {
  if (!responsePath || !path.isAbsolute(responsePath)) {
    throw new Error('Synthetic host receipt path must be absolute')
  }
  return AccountPoolViewSchema.parse(JSON.parse(readFileSync(responsePath, 'utf8')))
}

async function capture(page: Page, name: string) {
  if (!screenshotDir || !path.isAbsolute(screenshotDir)) {
    throw new Error('Screenshot directory must be absolute')
  }
  const cdp = await page.context().newCDPSession(page)
  try {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false
    })
    writeFileSync(path.join(screenshotDir, name), Buffer.from(data, 'base64'))
  } finally {
    await cdp.detach()
  }
}

async function openUsage(app: ElectronApplication, page: Page, view: AccountPoolView) {
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await app.evaluate(
    ({ ipcMain }, { view }) => {
      const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers')
      if (!(handlers instanceof Map)) {
        throw new Error('IPC handler registry unavailable')
      }
      const originalCall: unknown = handlers.get('runtime:call')
      if (typeof originalCall !== 'function') {
        throw new Error('Runtime call handler unavailable')
      }
      ipcMain.removeHandler('codexAccounts:list')
      ipcMain.handle('codexAccounts:list', () => ({
        accounts: [
          {
            id: 'high',
            email: 'high@example.test',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'low',
            email: 'low@example.test',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeAccountId: 'low',
        activeAccountIdsByRuntime: { host: 'low', wsl: {} }
      }))
      ipcMain.removeHandler('claudeAccounts:list')
      ipcMain.handle('claudeAccounts:list', () => ({
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      }))
      ipcMain.removeHandler('runtime:call')
      ipcMain.handle('runtime:call', (event, request: { method: string }) =>
        request.method === 'accountPool.list'
          ? {
              id: 'captured-host-receipt',
              ok: true,
              _meta: { runtimeId: 'synthetic-host' },
              result: view
            }
          : originalCall(event, request)
      )
    },
    { view }
  )
  await page.evaluate(() => {
    const store = window.__store!
    store.setState((state) => ({
      detectedAgentIds: ['codex'],
      statusBarVisible: true,
      statusBarItems: ['codex'],
      rateLimits: {
        ...state.rateLimits,
        codex: {
          provider: 'codex',
          status: 'ok',
          error: null,
          updatedAt: Date.now(),
          session: {
            usedPercent: 50,
            windowMinutes: 300,
            resetsAt: Date.now() + 60_000,
            resetDescription: null
          },
          weekly: {
            usedPercent: 50,
            windowMinutes: 10_080,
            resetsAt: Date.now() + 3_600_000,
            resetDescription: null
          },
          usageMetadata: { authProvenance: 'profile:low' }
        }
      }
    }))
  })
  const trigger = page.getByRole('button', { name: 'Usage', exact: true })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const usage = page.getByRole('dialog', { name: 'Usage', exact: true })
  await expect(usage).toBeVisible()
  const low = usage.getByRole('group', { name: 'Codex low@example.test usage' })
  const lowButton = low.getByRole('button')
  await lowButton.focus()
  await expect(lowButton).toBeFocused()
  await page.keyboard.press('Enter')
  const details = usage.getByRole('complementary', { name: 'Codex low@example.test details' })
  await expect(details).toBeVisible()
  return { usage, low, details }
}

test('fresh hidden Usage reads the captured host decision, with keyboard and light/dark/narrow geometry', async ({
  electronApp,
  orcaPage: page
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const { usage, low, details } = await openUsage(electronApp, page, hostResponse())
  await expect(details).toContainText('Selected account 5% used')
  await expect(details).toContainText('current account 50% used')
  await capture(page, 'quota-light.png')
  const other = usage.getByRole('group', { name: 'Codex high@example.test usage' })
  await other.getByRole('button').focus()
  const otherDetails = usage.getByRole('complementary', { name: 'Codex high@example.test details' })
  await expect(otherDetails).not.toContainText('Selected account 5% used')
  await page.evaluate(async () => {
    await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
  })
  await low.getByRole('button').focus()
  await expect(details).toContainText('current account 50% used')
  await capture(page, 'quota-dark.png')
  await page.setViewportSize({ width: 720, height: 900 })
  await expect(details).toBeVisible()
  const geometry = await details.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const reason = [...element.querySelectorAll('p')].find((node) =>
      node.textContent?.includes('Selected account 5% used')
    )
    return {
      visible: rect.left >= 0 && rect.right <= window.innerWidth,
      wrapped: reason ? reason.scrollWidth <= reason.clientWidth + 1 : false
    }
  })
  expect(geometry).toEqual({ visible: true, wrapped: true })
  await capture(page, 'quota-narrow.png')
  expect(pageErrors).toEqual([])
})

test('fresh hidden Usage omits an old-peer reason field', async ({
  electronApp,
  orcaPage: page
}) => {
  const response = hostResponse()
  const legacy: AccountPoolView = {
    ...response,
    assignments: response.assignments.map(({ selectionReason: _reason, ...rest }) => rest)
  }
  const { details } = await openUsage(electronApp, page, legacy)
  await expect(details).toContainText('Pool · equalize quota usage')
  await expect(details).not.toContainText('Compared verified')
  await capture(page, 'quota-old-peer.png')
})

test('fresh hidden Usage does not attach a foreign roster decision', async ({
  electronApp,
  orcaPage: page
}) => {
  const response = hostResponse()
  const foreign: AccountPoolView = {
    ...response,
    accounts: {
      ...response.accounts,
      codex: {
        ...response.accounts.codex,
        accounts: response.accounts.codex.accounts.filter((account) => account.id !== 'low')
      }
    }
  }
  const { details } = await openUsage(electronApp, page, foreign)
  await expect(details).toContainText('Pool status unavailable')
  await expect(details).not.toContainText('Selected account 5% used')
  await capture(page, 'quota-wrong-roster.png')
})
