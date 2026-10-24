import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit background Electron required')
test.use({ trace: 'off', screenshot: 'off', reducedMotion: 'reduce' })

test('manual beta buttons leave the app usable without starting renderer shutdown', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(90000)
  expect(testRepoPath).toBeTruthy()
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  const { app, page } = await session.launch({ executablePath })
  try {
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      let status = {
        state: 'available',
        version: '0.1.0-rc.2',
        manualInstaller: true,
        changelog: null
      }
      for (const name of ['updater:getStatus', 'updater:download', 'updater:quitAndInstall']) {
        ipcMain.removeHandler(name)
      }
      const publish = () => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('updater:status', status)
        }
      }
      ipcMain.handle('updater:getStatus', () => status)
      ipcMain.handle('updater:download', () => {
        status = { ...status, state: 'downloaded' }
        publish()
      })
      ipcMain.handle('updater:quitAndInstall', () => {
        status = { ...status, state: 'idle' }
        publish()
      })
    })
    await page.evaluate(() =>
      window.__store?.setState({
        updateStatus: {
          state: 'available',
          version: '0.1.0-rc.2',
          manualInstaller: true,
          changelog: null
        },
        updateCardCollapsed: false,
        dismissedUpdateVersion: null,
        updateReassuranceSeen: true
      })
    )
    const download = page.getByRole('button', { name: 'Download installer', exact: true })
    await expect(download).toBeVisible()
    await expect(download).toBeInViewport()
    await page.screenshot({
      path: testInfo.outputPath('beta-download.png'),
      animations: 'disabled'
    })
    await download.click()
    const open = page.getByRole('button', { name: 'Open installer', exact: true })
    await expect(open).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restart to Update', exact: true })).toHaveCount(
      0
    )
    await page.screenshot({
      path: testInfo.outputPath('beta-open-installer.png'),
      animations: 'disabled'
    })
    await open.click()
    await expect(open).toHaveCount(0)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } finally {
    await session.dispose(app)
  }
})
