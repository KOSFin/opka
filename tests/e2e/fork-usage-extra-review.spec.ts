import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import type { Locator, Page } from '@stablyai/playwright-test'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' }, trace: 'off', screenshot: 'off' })

const evidence = path.join(process.cwd(), 'test-results/desktop-usage-independent-evidence')

async function capture(page: Page, name: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const result = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false
    })
    await mkdir(evidence, { recursive: true })
    await writeFile(path.join(evidence, name), Buffer.from(result.data, 'base64'))
  } finally {
    await cdp.detach()
  }
}

async function expectPopoverHitTarget(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const result = await target.evaluate((element) => {
    const popover = document.querySelector('[data-slot="popover-content"]')
    if (!popover) {
      return { within: false, hit: false }
    }
    const rect = element.getBoundingClientRect()
    const outer = popover.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return {
      within:
        rect.width > 0 &&
        rect.height > 0 &&
        x >= outer.left &&
        x <= outer.right &&
        y >= outer.top &&
        y <= outer.bottom &&
        x >= 0 &&
        x <= window.innerWidth &&
        y >= 0 &&
        y <= window.innerHeight,
      hit: element.contains(document.elementFromPoint(x, y))
    }
  })
  expect(result).toEqual({ within: true, hit: true })
}

test('fresh hidden Electron Usage has reachable account details and nested dismissal', async ({
  electronApp,
  orcaPage: page
}) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('claudeAccounts:list')
    ipcMain.handle('claudeAccounts:list', () => ({
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    }))
    ipcMain.removeHandler('codexAccounts:list')
    ipcMain.handle('codexAccounts:list', () => ({
      accounts: [
        {
          id: 'alpha',
          email: 'alpha@example.test',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'beta',
          email: 'beta@example.test',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        ...Array.from({ length: 18 }, (_, index) => ({
          id: `extra-${index}`,
          email: `extra-${index}@example.test`,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }))
      ],
      activeAccountId: 'alpha',
      activeAccountIdsByRuntime: { host: 'alpha', wsl: {} }
    }))
  })
  await page.evaluate(async () => {
    const store = window.__store!
    const previous = store.getState()
    await previous.updateSettingsOrThrow({ theme: 'light' })
    store.setState({
      detectedAgentIds: ['codex'],
      statusBarVisible: true,
      statusBarItems: ['codex'],
      rateLimits: {
        ...previous.rateLimits,
        codex: {
          provider: 'codex',
          status: 'ok',
          error: null,
          updatedAt: Date.now(),
          session: {
            usedPercent: 42,
            windowMinutes: 300,
            resetsAt: Date.now() + 60_000,
            resetDescription: null
          },
          weekly: {
            usedPercent: 56,
            windowMinutes: 10_080,
            resetsAt: Date.now() + 3_600_000,
            resetDescription: null
          },
          usageMetadata: { authProvenance: 'profile:alpha' },
          rateLimitResetCredits: {
            availableCount: 2,
            nextExpiresAt: Date.now() + 3_600_000
          }
        }
      }
    })
  })

  const trigger = page.getByRole('button', { name: 'Usage', exact: true })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const usage = page.getByRole('dialog', { name: 'Usage', exact: true })
  await expect(usage).toBeVisible()
  await expect(usage.getByText('Usage', { exact: true })).toHaveCount(1)
  const refresh = usage.getByRole('button', { name: 'Refresh rate limits' })
  const detailed = usage.getByRole('radio', { name: 'Detailed' })
  await expectPopoverHitTarget(refresh)
  await expectPopoverHitTarget(detailed)
  const alpha = usage.getByRole('group', { name: 'Codex alpha@example.test usage' })
  const beta = usage.getByRole('group', { name: 'Codex beta@example.test usage' })
  await expect(alpha.getByText('56%')).toBeVisible()
  await expect(beta.getByText('Limits unavailable')).toBeVisible()
  await detailed.click()
  await expect(alpha.getByText('42%')).toBeVisible()
  await alpha.getByRole('button').hover()
  const details = usage.getByRole('complementary', {
    name: 'Codex alpha@example.test details'
  })
  await expect(details).toBeVisible()
  await expect(details.getByText(/2 manual resets available/)).toBeVisible()
  const pin = details.getByRole('button', { name: /Pin alpha@example\.test to status bar/ })
  await alpha.getByRole('button').focus()
  await page.keyboard.press('Tab')
  await expect(beta.getByRole('button')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(alpha.getByRole('button')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(pin).toBeFocused()
  await expectPopoverHitTarget(pin)
  await pin.hover()
  await expect(details).toBeVisible()
  await capture(page, 'additional-light-detail.png')

  await beta.getByRole('button').focus()
  await expect(
    usage.getByRole('complementary', { name: 'Codex beta@example.test details' })
  ).toBeVisible()
  await alpha.getByRole('button').focus()
  await page.keyboard.press('Enter')
  await expect(pin).toBeFocused()
  await pin.click()
  await expect(
    details.getByRole('button', { name: /Unpin alpha@example\.test from status bar/ })
  ).toBeVisible()
  const reset = details.getByRole('button', { name: 'Use reset', exact: true })
  await expectPopoverHitTarget(reset)
  await reset.click()
  const confirmation = page.getByRole('dialog', { name: 'Use one manual reset?' })
  await expect(confirmation).toBeVisible()
  await expect(confirmation.getByText(/2 available resets/)).toBeVisible()
  await expect(confirmation.getByText(/expires/i)).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(reset).toBeFocused()
  await expect(usage).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(usage).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await alpha.getByRole('button').hover()
  await expect(
    usage
      .getByRole('complementary', { name: 'Codex alpha@example.test details' })
      .getByRole('button', { name: /Unpin alpha@example\.test from status bar/ })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
  })
  await trigger.click()
  await alpha.getByRole('button').hover()
  await expectPopoverHitTarget(refresh)
  await expectPopoverHitTarget(details.getByRole('button', { name: /Unpin alpha@example\.test/ }))
  await capture(page, 'additional-dark-detail.png')

  await page.setViewportSize({ width: 540, height: 680 })
  await expect(usage).toBeVisible()
  await expectPopoverHitTarget(refresh)
  const last = usage.getByRole('group', { name: 'Codex extra-17@example.test usage' })
  await last.getByRole('button').scrollIntoViewIfNeeded()
  await expectPopoverHitTarget(last.getByRole('button'))
  const scrolled = await usage.evaluate((node) =>
    Array.from(node.querySelectorAll('*')).some((element) => element.scrollTop > 0)
  )
  expect(scrolled).toBe(true)
  await alpha.getByRole('button').scrollIntoViewIfNeeded()
  await alpha.getByRole('button').hover()
  await expectPopoverHitTarget(details.getByRole('button', { name: /Unpin alpha@example\.test/ }))
  await page.screenshot({
    path: path.join(evidence, 'additional-dark-narrow-scrolled.png'),
    timeout: 15_000
  })
  const history = usage.getByRole('button', { name: 'Usage details & history' })
  const manage = usage.getByRole('button', { name: 'Manage Accounts…' })
  await expectPopoverHitTarget(history)
  await expectPopoverHitTarget(manage)
  const geometry = await usage.evaluate((element) => {
    const scroller = element.firstElementChild
    const roster = scroller?.firstElementChild
    const dimensions = (node: Element | null | undefined) => ({
      clientWidth: node?.clientWidth ?? -1,
      scrollWidth: node?.scrollWidth ?? -1
    })
    return {
      popover: dimensions(element),
      scroller: dimensions(scroller),
      roster: dimensions(roster)
    }
  })
  await writeFile(path.join(evidence, 'narrow-horizontal-geometry.json'), JSON.stringify(geometry))
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.evaluate(() => {
    const store = window.__store!
    store.setState((state) => {
      const codex = state.rateLimits.codex
      if (!codex) {
        throw new Error('Missing synthetic Codex rate limit')
      }
      return {
        rateLimits: {
          ...state.rateLimits,
          codex: {
            ...codex,
            updatedAt: Date.now(),
            rateLimitResetCredits: { availableCount: 2, nextExpiresAt: Date.now() - 1000 }
          }
        }
      }
    })
  })
  await trigger.click()
  await alpha.getByRole('button').hover()
  await expect(details.getByRole('button', { name: 'Use reset' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('codexAccounts:list')
    ipcMain.handle('codexAccounts:list', () => ({
      accounts: [{ id: 'beta', email: 'beta@example.test', createdAt: 1, updatedAt: 1 }],
      activeAccountId: 'beta',
      activeAccountIdsByRuntime: { host: 'beta', wsl: {} }
    }))
  })
  await trigger.click()
  await expect(beta).toBeVisible()
  await expect(alpha).toHaveCount(0)
  await expect(usage.getByRole('complementary', { name: /alpha@example\.test/ })).toHaveCount(0)
  await expectPopoverHitTarget(history)
  await expectPopoverHitTarget(manage)
  await history.click()
  await expect(usage).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__store!.getState().activeView))
    .toBe('settings')
  await trigger.click()
  await manage.click()
  await expect(usage).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__store!.getState().activeView))
    .toBe('settings')
  expect(geometry.scroller.scrollWidth).toBeLessThanOrEqual(geometry.scroller.clientWidth)
  expect(pageErrors).toEqual([])
})
