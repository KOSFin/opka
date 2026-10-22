import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  createElectronHomeIsolation,
  assertElectronResolvedIsolatedHome
} from '../../tests/e2e/helpers/electron-home-isolation.ts'
import { prepareAcceptanceFixture } from './fork-acceptance-fixture.mjs'
import { stageRemoteAcceptance, connectRemoteAcceptance } from './fork-acceptance-remote.mjs'
import { repairAcceptanceProject } from './fork-acceptance-project-repair.mjs'
import {
  checkAcceptanceNavigation,
  installTaskTimingProbe,
  readTaskTimingProbe
} from './fork-acceptance-navigation.mjs'
import { captureAcceptanceSidebar } from './fork-acceptance-sidebar.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const area = path.join(root, '.tmp/fork-acceptance')
const profileName = process.env.ORCA_ACCEPTANCE_PROFILE ?? 'profile'
if (!/^profile(?:-[a-z0-9-]+)?$/.test(profileName)) {
  throw new Error('Expected an isolated acceptance profile name')
}
const profile = path.join(area, profileName)
const workspace = path.join(homedir(), 'Library/Application Support/Orca Fork Acceptance/workspace')
const executable = path.join(
  process.env.ORCA_ACCEPTANCE_APP_DIR ?? path.join(root, 'dist/mac-arm64/Orca.app'),
  'Contents/MacOS/Orca'
)
const receipt = path.join(
  area,
  profileName === 'profile' ? 'prepared.json' : `${profileName}-prepared.json`
)
const action = process.argv[2]
if (
  process.platform !== 'darwin' ||
  !['--prepare', '--prepare-remote', '--check', '--open'].includes(action)
) {
  throw new Error('macOS: use --prepare, --prepare-remote, --check or --open (Node 24+)')
}
if (!existsSync(executable)) {
  throw new Error('Build the iteration 3 Mac package first')
}
mkdirSync(profile, { recursive: true, mode: 0o700 })
prepareAcceptanceFixture(workspace)
if (action === '--prepare-remote') {
  stageRemoteAcceptance(area, profile)
}

// Reuse the tested HOME boundary instead of inheriting real CLI credentials.
const isolation = createElectronHomeIsolation({
  inheritedEnv: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8' },
  launchEnv: {
    ORCA_FORK_PROFILE_CLI: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    ORCA_ORCAD_TEMPLATE_PATH: path.join(root, 'out/orcad-template'),
    ORCA_E2E_RUNTIME_WS_PORT: '0'
  },
  extraEnv: {},
  userDataDir: profile
})
const args = [
  '--password-store=basic',
  '--use-mock-keychain',
  '-ApplePersistenceIgnoreState',
  'YES'
]
if (action === '--open') {
  if (!process.stdin.isTTY || process.env.ORCA_BACKGROUND_LAUNCH === '1') {
    throw new Error('Visible launch is for the user in Terminal only; automation must use --check')
  }
  if (!existsSync(receipt)) {
    throw new Error('Run --prepare before opening the acceptance profile')
  }
  const log = openSync(path.join(area, 'manual-launch.log'), 'a', 0o600)
  const child = spawn(executable, args, {
    env: isolation.env,
    cwd: workspace,
    detached: true,
    stdio: ['ignore', log, log]
  })
  child.on('error', () => {
    process.exitCode = 1
  })
  child.unref()
  closeSync(log)
  console.log(
    'Fork test opened. Quit this test Orca with Cmd+Q. Test files and chats are retained.'
  )
} else {
  const { _electron: electron, expect } = await import('@stablyai/playwright-test')
  const startedAt = Date.now()
  const timings = {}
  const app = await electron.launch({
    executablePath: executable,
    args,
    env: { ...isolation.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  try {
    if (
      process.env.ORCA_ACCEPTANCE_TRACE_TASKS === '1' ||
      process.env.ORCA_ACCEPTANCE_PROBE_NAVIGATION === '1'
    ) {
      await installTaskTimingProbe(app, [
        'repos:getBaseRefDefault',
        'git:branchCompare',
        'runtimeEnvironments:call',
        'runtime:call'
      ])
    }
    const actual = await app.evaluate(({ app, BrowserWindow }) => ({
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      version: app.getVersion(),
      visibleWindows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length
    }))
    assertElectronResolvedIsolatedHome(actual.home, isolation)
    if (actual.userData !== profile || actual.visibleWindows !== 0) {
      throw new Error('Profile isolation failed')
    }
    const page = await app.firstWindow({ timeout: 120000 })
    page.on('console', (message) => {
      if (message.text().startsWith('[fork-remote-stage] ')) {
        console.log(message.text())
      }
    })
    await page.waitForFunction(() => Boolean(window.api?.projectGroups), null, { timeout: 30000 })
    const profileCli = await page.evaluate(async (prepare) => {
      const status = await window.api.cli.getInstallStatus()
      if (status.registrationScope !== 'profile') {
        throw new Error('Refusing CLI setup outside the isolated profile')
      }
      return prepare ? window.api.cli.install() : status
    }, action.startsWith('--prepare'))
    expect(profileCli.state).toBe('installed')
    expect(profileCli.commandPath).toBe(path.join(profile, 'cli/bin/orca-fork'))
    expect(profileCli.pathConfigured).toBe(false)
    timings.shellReadyMs = Date.now() - startedAt
    let local = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')).local : undefined
    if (action === '--prepare' && !local) {
      local = await page.evaluate(async (folderPath) => {
        const group =
          (await window.api.projectGroups.list()).find(
            (entry) => entry.parentPath === folderPath && !entry.parentGroupId
          ) ??
          (await window.api.projectGroups.create({
            name: 'LOCAL — Fork acceptance',
            parentPath: folderPath
          }))
        const folder =
          (await window.api.folderWorkspaces.list()).find(
            (entry) => entry.folderPath === folderPath && entry.projectGroupId === group.id
          ) ??
          (await window.api.folderWorkspaces.create({
            projectGroupId: group.id,
            name: 'LOCAL — учебные задачи',
            folderPath
          }))
        return { folderId: folder.id }
      }, workspace)
      await page.reload()
      await page.waitForFunction(() => Boolean(window.api?.projectGroups))
    }
    if (!local?.folderId) {
      local = await page.evaluate(async () => {
        const folders = await window.api.folderWorkspaces.list()
        const folder = folders.find((entry) => entry.name === 'LOCAL — учебные задачи')
        if (!folder) {
          throw new Error('Local acceptance folder missing; run --prepare')
        }
        return { folderId: folder.id }
      })
    }
    if (action === '--prepare') {
      await page.evaluate(
        async ({ folderId, folderPath }) => {
          await window.api.folderWorkspaces.update({
            folderWorkspaceId: folderId,
            updates: { folderPath }
          })
        },
        { folderId: local.folderId, folderPath: workspace }
      )
    }
    if (action === '--prepare') {
      await page.evaluate(async (folderPath) => {
        const scan = await window.api.projectGroups.scanNested({ path: folderPath })
        if (scan.repos.length !== 3) {
          throw new Error(`Expected three synthetic repositories: ${JSON.stringify(scan)}`)
        }
        const imported = await window.api.projectGroups.importNested({
          parentPath: folderPath,
          groupName: 'LOCAL — Fork acceptance',
          mode: 'group',
          projectPaths: scan.repos.map((repo) => repo.path)
        })
        if (imported.failedCount) {
          throw new Error('Nested import failed')
        }
        await window.api.onboarding.update({
          flowVersion: 4,
          closedAt: Date.now(),
          outcome: 'completed',
          lastCompletedStep: 5
        })
      }, workspace)
      await page.reload()
      await page.waitForFunction(() => Boolean(window.api?.projectGroups))
    }
    const taskCount = await page.evaluate(async (folderId) => {
      const result = await window.api.runtime.call({
        method: 'projectTask.list',
        params: { worktree: `folder:${folderId}`, offset: 0, limit: 100 }
      })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      if (result.result.diagnostics.length) {
        throw new Error('Local task index diagnostics')
      }
      return result.result.total
    }, local.folderId)
    timings.localIndexReadyMs = Date.now() - startedAt
    const remote =
      action === '--prepare-remote'
        ? await connectRemoteAcceptance(
            page,
            existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')).remote : undefined
          )
        : existsSync(receipt)
          ? JSON.parse(readFileSync(receipt, 'utf8')).remote
          : undefined
    const projectRepair =
      action === '--prepare'
        ? await repairAcceptanceProject(page, { root: workspace, folderId: local.folderId })
        : undefined
    if (!(await page.getByRole('heading', { name: 'Project tasks', exact: true }).isVisible())) {
      await page.locator('[data-contextual-tour-target="sidebar-tasks"]').click()
    }
    await page.getByRole('heading', { name: 'Project tasks', exact: true }).waitFor()
    timings.taskViewSelectedMs = Date.now() - startedAt
    const projectPicker = page.getByRole('combobox', { name: 'Task project', exact: true })
    if (!(await projectPicker.textContent())?.includes('All projects')) {
      await projectPicker.click()
      await page.getByRole('option', { name: 'All projects', exact: true }).click()
    }
    await expect(projectPicker).toContainText('All projects')
    timings.allProjectsSelectedMs = Date.now() - startedAt
    const mainCards = page.getByRole('button', { name: /Проверить связку backend и web/ })
    await expect(mainCards.filter({ hasText: 'LOCAL — Fork acceptance' })).toHaveCount(1, {
      timeout: 30000
    })
    timings.firstLocalCardsReadyMs = Date.now() - startedAt
    if (remote) {
      await expect(mainCards.filter({ hasText: 'REMOTE — Fork acceptance' })).toHaveCount(1, {
        timeout: 30000
      })
      timings.remoteCardsReadyMs = Date.now() - startedAt
    }
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    timings.refreshClickedMs = Date.now() - startedAt
    await expect(page.getByRole('button', { name: /Проверить связку backend и web/ })).toHaveCount(
      remote ? 2 : 1,
      { timeout: 30000 }
    )
    await expect(page.getByRole('alert')).toHaveCount(0)
    timings.allProjectCardsReadyMs = Date.now() - startedAt
    const taskRpcTimings =
      process.env.ORCA_ACCEPTANCE_TRACE_TASKS === '1'
        ? await page.evaluate(async (remoteId) => {
            const timings = []
            for (const environmentId of [null, ...(remoteId ? [remoteId] : [])]) {
              const call = async (method, params) => {
                const started = performance.now()
                const response = environmentId
                  ? await window.api.runtimeEnvironments.call({
                      selector: environmentId,
                      method,
                      params
                    })
                  : await window.api.runtime.call({ method, params })
                timings.push({
                  host: environmentId ? 'remote' : 'local',
                  method,
                  ms: performance.now() - started,
                  ok: response.ok
                })
                if (!response.ok) {
                  throw new Error(`Task timing failed: ${method}`)
                }
                return response.result
              }
              const catalog = await call('projectTask.catalog')
              for (const project of catalog.projects.filter(
                (entry) => entry.state === 'configured'
              )) {
                await call('projectTask.board', {
                  worktree: project.selector,
                  offset: 0,
                  limit: 100
                })
              }
            }
            return timings
          }, remote?.environmentId)
        : undefined
    const sidebarDiagnostic =
      process.env.ORCA_ACCEPTANCE_CAPTURE_SIDEBAR === '1'
        ? await captureAcceptanceSidebar(page, area, remote)
        : undefined
    const navigation =
      process.env.ORCA_ACCEPTANCE_PROBE_NAVIGATION === '1'
        ? await checkAcceptanceNavigation(page, expect, { workspace, remote, app })
        : undefined
    const report = {
      checkedAt: new Date().toISOString(),
      ...actual,
      workspace,
      local,
      projectRepair,
      profileCli,
      navigation,
      sidebarDiagnostic,
      timings,
      taskRpcTimings,
      rpcWaterfall:
        process.env.ORCA_ACCEPTANCE_TRACE_TASKS === '1'
          ? await readTaskTimingProbe(app)
          : undefined,
      taskCount,
      allProjectsRendered: true,
      syntheticOnly: true,
      credentialsAllowed: false,
      remotePrepared: Boolean(remote),
      remote
    }
    if (action !== '--check') {
      writeFileSync(receipt, JSON.stringify(report, null, 2), { mode: 0o600 })
    }
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    const page = app.windows().find((entry) => !entry.isClosed())
    if (page) {
      await page.screenshot({ path: path.join(area, 'entry-failure.png') }).catch(() => {})
      console.error(
        JSON.stringify({
          timings,
          rpcWaterfall:
            process.env.ORCA_ACCEPTANCE_TRACE_TASKS === '1'
              ? await readTaskTimingProbe(app)
              : undefined,
          taskAlerts: await page
            .getByRole('alert')
            .allTextContents()
            .catch(() => []),
          acceptanceDialogHeadings: await page
            .locator('[role="dialog"] h1, [role="dialog"] h2')
            .allTextContents()
            .catch(() => [])
        })
      )
    }
    throw error
  } finally {
    await app.close()
  }
}
