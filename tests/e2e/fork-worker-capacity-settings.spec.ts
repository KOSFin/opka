import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit isolated background Electron required')
test.use({ trace: 'off', screenshot: 'off' })

async function openOrchestration(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'orchestration', repoId: null })
    state.openSettingsPage()
  })
}

test('operator worker limit survives restart and can be disabled', async ({
  testRepoPath
}, info) => {
  expect(testRepoPath).toBeTruthy()
  const session = createRestartSession(info, { ORCA_BACKGROUND_LAUNCH: '1' })
  let app: ElectronApplication | undefined
  try {
    let launched = await session.launch({ executablePath })
    app = launched.app
    await openOrchestration(launched.page)
    const toggle = launched.page.getByRole('switch', { name: 'Limit parallel workers' })
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    const input = launched.page.getByRole('spinbutton', { name: 'Maximum parallel workers' })
    await expect(input).toHaveValue('5')
    await input.fill('3')
    await input.press('Tab')
    await expect
      .poll(() =>
        launched.page.evaluate(() => window.__store!.getState().settings?.maxConcurrentWorkers)
      )
      .toBe(3)
    await launched.page.screenshot({ path: info.outputPath('worker-capacity-settings.png') })
    await session.close(app)
    app = undefined
    launched = await session.launch({ executablePath })
    app = launched.app
    await openOrchestration(launched.page)
    await expect(
      launched.page.getByRole('spinbutton', {
        name: 'Maximum parallel workers'
      })
    ).toHaveValue('3')
    await launched.page.getByRole('switch', { name: 'Limit parallel workers' }).click()
    await expect(
      launched.page.getByRole('spinbutton', {
        name: 'Maximum parallel workers'
      })
    ).toHaveCount(0)
    await expect
      .poll(() =>
        launched.page.evaluate(() => window.__store!.getState().settings?.maxConcurrentWorkers)
      )
      .toBeNull()
  } finally {
    await session.dispose(app)
  }
})
