import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import {
  probeRemoteProjectTask,
  verifyRemoteProjectTaskResume
} from './helpers/remote-project-task-probe'

const host = process.env.ORCA_FORK_AUDIT_SSH_HOST
const identityFile = process.env.ORCA_FORK_AUDIT_IDENTITY_FILE
const username = process.env.ORCA_FORK_AUDIT_SSH_USER
const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
const template = process.env.ORCA_FORK_AUDIT_TEMPLATE
const verifyNestedTree = process.env.ORCA_FORK_AUDIT_NESTED === '1'
const verifyFileTasks = process.env.ORCA_FORK_AUDIT_TASKS === '1'
const remoteRepo = process.env.ORCA_FORK_AUDIT_REMOTE_REPO
const nestedRoot = process.env.ORCA_FORK_AUDIT_NESTED_ROOT
test.skip(
  !host ||
    !identityFile ||
    !username ||
    !remoteRepo ||
    !executablePath ||
    !template ||
    (verifyNestedTree && !nestedRoot),
  'Explicit isolated audit host required'
)
// Pairing credentials must not enter Playwright's protocol traces.
test.use({ trace: 'off', screenshot: 'off' })

test('fork GUI connects to the isolated audit host and reconnects without losing its project', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(8 * 60_000)
  expect(testRepoPath).toBeTruthy()
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    ORCA_ORCAD_TEMPLATE_PATH: template!
  })
  const sshDirectory = path.join(session.userDataDir, 'home', '.ssh')
  mkdirSync(sshDirectory, { recursive: true, mode: 0o700 })
  // Trust only the existing verified host entry; never disable host-key checking.
  const knownHost = execFileSync('/usr/bin/ssh-keygen', ['-F', host!], { encoding: 'utf8' })
  writeFileSync(path.join(sshDirectory, 'known_hosts'), knownHost, { mode: 0o600 })
  let app: ElectronApplication | undefined
  let activePage: Page | undefined
  let targetId: string | undefined
  let environmentId: string | undefined
  let projectTask: { id: string; worktree: string } | undefined
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    const page = launched.page
    activePage = page
    const isolation = await app.evaluate(({ app, BrowserWindow }) => ({
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      dockVisible: app.dock?.isVisible() ?? false,
      visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length
    }))
    expect(isolation.home).toContain(session.userDataDir)
    expect(isolation.userData).toContain(session.userDataDir)
    expect(isolation.dockVisible).toBe(false)
    expect(isolation.visibleWindows).toBe(0)
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await page.screenshot({ path: testInfo.outputPath('isolated-local-gui.png') })
    targetId = await page.evaluate(
      async (input) => {
        const { target } = await window.api.ssh.addTarget({ target: input })
        const connected = await window.api.ssh.connect({ targetId: target.id })
        if (connected?.status !== 'connected') {
          throw new Error(`SSH status: ${connected?.status}`)
        }
        return target.id
      },
      {
        label: 'Fork isolated audit',
        host: host!,
        port: 22,
        username: username!,
        identityFile: identityFile!,
        identitiesOnly: true
      }
    )
    await expect
      .poll(
        async () => {
          const environments = await page.evaluate(() => window.api.runtimeEnvironments.list())
          const environment = environments.find((entry) => {
            const deployment = entry.orcadDeployment
            return deployment && deployment.kind !== 'wsl' && deployment.sshTargetId === targetId
          })
          environmentId = environment?.id
          return Boolean(environment)
        },
        { timeout: 120_000 }
      )
      .toBe(true)
    await page.evaluate(
      async ({ environmentId, remoteRepo }) => {
        const store = window.__store!
        store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
        await store.getState().refreshRuntimeEnvironmentStatus(environmentId)
        if (!(await store.getState().setActiveRuntimeEnvironmentPreference(environmentId))) {
          throw new Error('Could not select the audit runtime')
        }
        const result = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'repo.add',
          params: { path: remoteRepo, kind: 'git', displayName: 'Fork audit workspace' }
        })
        if (!result.ok) {
          throw new Error(result.error.message)
        }
        await store
          .getState()
          .fetchRepos({ runtimeEnvironmentId: environmentId, throwOnError: true })
      },
      { environmentId: environmentId!, remoteRepo: remoteRepo! }
    )
    await expect(page.getByText('Fork audit workspace', { exact: true }).first()).toBeVisible({
      timeout: 30_000
    })
    if (verifyNestedTree) {
      const nested = await page.evaluate(
        async ({ runtimeEnvironmentId, root }) => {
          const state = window.__store!.getState()
          const scan = await state.scanNestedRepos(root, undefined, { runtimeEnvironmentId })
          if (!scan) {
            throw new Error('Remote nested scan unavailable')
          }
          const imported = await state.importNestedRepos({
            parentPath: root,
            groupName: 'Remote tree',
            mode: 'group',
            runtimeEnvironmentId,
            projectPaths: scan.repos.map((repo) => repo.path)
          })
          if (!imported) {
            throw new Error('Remote nested import unavailable')
          }
          return {
            found: scan.repos.length,
            imported: imported.importedCount + imported.alreadyKnownCount,
            failed: imported.failedCount
          }
        },
        { runtimeEnvironmentId: environmentId!, root: nestedRoot! }
      )
      expect(nested).toEqual({ found: 5, imported: 5, failed: 0 })
      await expect(page.getByText('Remote tree', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('payments', { exact: true }).first()).toBeVisible()
      writeFileSync(testInfo.outputPath('remote-tree-result.json'), JSON.stringify(nested), {
        mode: 0o600
      })
    }
    if (verifyFileTasks) {
      projectTask = await probeRemoteProjectTask(page, environmentId!, remoteRepo!)
    }
    await page.screenshot({ path: testInfo.outputPath('isolated-remote-gui.png') })
    await page.evaluate(async (id) => {
      await window.api.ssh.disconnect({ targetId: id })
      const state = await window.api.ssh.connect({ targetId: id })
      if (state?.status !== 'connected') {
        throw new Error('Audit SSH reconnect failed')
      }
    }, targetId)
    await expect(page.getByText('Fork audit workspace', { exact: true }).first()).toBeVisible()
    const remote = await page.evaluate(
      (selector) =>
        window.api.runtimeEnvironments.call({
          selector,
          method: 'repo.list',
          params: {}
        }),
      environmentId!
    )
    expect(remote.ok).toBe(true)
    if (projectTask) {
      await verifyRemoteProjectTaskResume(page, environmentId!, projectTask)
    }
    if (remote.ok) {
      expect(JSON.stringify(remote.result)).toContain(remoteRepo)
    }
    writeFileSync(
      testInfo.outputPath('audit-result.json'),
      JSON.stringify(
        {
          isolation,
          connected: true,
          reconnected: true,
          remoteProjectVisible: true
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  } finally {
    try {
      if (activePage && environmentId) {
        // Stop only this explicitly created managed runtime, even if a UI assertion fails.
        const stopped = await activePage.evaluate(async (selector) => {
          // A selected default host is deliberately protected from stop.
          await window.__store!.getState().setActiveRuntimeEnvironmentPreference(null)
          const managed = window.api.runtimeEnvironments.managedOrcad
          if (!managed) {
            throw new Error('Desktop managed server API unavailable')
          }
          return managed.stop({ selector })
        }, environmentId)
        writeFileSync(testInfo.outputPath('audit-stop.json'), JSON.stringify(stopped, null, 2), {
          mode: 0o600
        })
        expect(stopped).toMatchObject({ outcome: 'unlinked', verdict: 'exited' })
      }
    } finally {
      await session.dispose(app)
    }
  }
})
