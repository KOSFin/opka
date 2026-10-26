import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { forkInstallerProbes } from './helpers/fork-installer-probe'

const packagedApp = process.env.ORCA_FORK_PACKAGED_APP
test.skip(!packagedApp || process.platform !== 'darwin', 'Explicit isolated Mac package required')
test.use({ trace: 'off', screenshot: 'off' })
const probes = forkInstallerProbes(process.env)

async function waitForState(page: Page, state: 'available' | 'downloaded', timeout: number) {
  await expect
    .poll(
      async () => {
        const status = await page.evaluate(() => window.api.updater.getStatus())
        if (status.state === 'error') {
          throw new Error(`Installer ${state}: ${status.message}`)
        }
        return status.state
      },
      { timeout }
    )
    .toBe(state)
}

test('packaged updater streams and verifies a published installer without opening it', async ({
  browserName
}, info) => {
  test.setTimeout(960000)
  expect(browserName).toBe('chromium')
  if (!packagedApp) {
    throw new Error('Explicit private package missing')
  }
  const session = createRestartSession(info, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    ORCA_ENVIRONMENT: '',
    ORCA_PAIRING_CODE: '',
    ORCA_REMOTE_PAIRING: ''
  })
  const temporary = join(session.userDataDir, 'installer-download')
  mkdirSync(temporary, { mode: 0o700 })
  let app: ElectronApplication | undefined
  try {
    const launched = await session.launch({
      executablePath: join(packagedApp, 'Contents', 'MacOS', 'Opka'),
      packaged: true,
      beforeFirstWindow: async (application) => {
        await application.evaluate(
          ({ app }, directory) => app.setPath('temp', directory),
          temporary
        )
      }
    })
    app = launched.app
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const version = await app.evaluate(({ app }) => app.getVersion())
    const probe = probes.find((candidate) => candidate.version !== version)
    if (!probe) {
      throw new Error('Different-version installer probe missing')
    }
    const blocker = await app.evaluate(({ powerSaveBlocker }) =>
      powerSaveBlocker.start('prevent-app-suspension')
    )
    try {
      await launched.page.evaluate(
        (version) => window.api.updater.check({ channel: 'rc', targetTag: `v${version}` }),
        probe.version
      )
      await waitForState(launched.page, 'available', 45000)
      await expect(
        launched.page.evaluate(() => window.api.updater.getStatus())
      ).resolves.toMatchObject({ version: probe.version, manualInstaller: true })
      await launched.page.evaluate(() => window.api.updater.download())
      await waitForState(launched.page, 'downloaded', 900000)
    } finally {
      await app.evaluate(({ powerSaveBlocker }, id) => powerSaveBlocker.stop(id), blocker)
    }
    const directories = readdirSync(temporary).filter((name) => name.startsWith('opka-update-'))
    expect(directories).toHaveLength(1)
    const directory = directories[0]
    if (!directory) {
      throw new Error('Verified installer directory missing')
    }
    const installer = join(temporary, directory, 'opka-macos-arm64.dmg')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(installer)) {
      hash.update(chunk)
    }
    expect(hash.digest('hex')).toBe(probe.sha256)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
    writeFileSync(
      info.outputPath('installer-download-receipt.json'),
      JSON.stringify({
        appVersion: version,
        downloadedVersion: probe.version,
        sha256: probe.sha256,
        bytes: statSync(installer).size,
        opened: false
      })
    )
  } finally {
    await session.dispose(app)
  }
})
