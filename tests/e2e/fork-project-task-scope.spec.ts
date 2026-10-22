import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import type { ElectronApplication } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit isolated background Electron required')
test.use({ trace: 'off', screenshot: 'off' })

test('all projects keeps two identically named tasks separate and selects projects instead of branches', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180000)
  expect(testRepoPath).toBeTruthy()
  const roots = ['Alpha', 'Beta'].map(() =>
    realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-project-scope-')))
  )
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1'
  })
  let app: ElectronApplication | undefined
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    const page = launched.page
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await page.evaluate(
      async ({ roots, content }) => {
        const call = async (method: string, params: object) => {
          const response = await window.api.runtime.call({ method, params })
          if (!response.ok) {
            throw new Error(response.error.message)
          }
          return response.result
        }
        for (const [index, folderPath] of roots.entries()) {
          const group = await window.api.projectGroups.create({
            name: index ? 'Beta project' : 'Alpha project',
            parentPath: folderPath
          })
          const folder = await window.api.folderWorkspaces.create({
            projectGroupId: group.id,
            folderPath,
            name: 'Project home'
          })
          const worktree = `folder:${folder.id}`
          await call('projectTask.init', { worktree, expectedExecutionHostId: 'local' })
          await call('projectTask.create', {
            worktree,
            expectedExecutionHostId: 'local',
            source: 'project',
            slug: 'shared',
            content
          })
        }
        window.localStorage.removeItem('orca.projectTask.view.v2')
        await window.__store!.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
        window.__store!.getState().setActiveView('tasks')
      },
      {
        roots,
        content: projectTaskTemplate({
          id: 'task-33333333-3333-4333-8333-333333333333',
          title: 'Shared plan'
        })
      }
    )
    await expect(page.getByRole('heading', { name: 'Project tasks', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('button', { name: /Shared plan.*Alpha project/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Shared plan.*Beta project/ })).toBeVisible()
    await page.getByRole('button', { name: /Shared plan.*Beta project/ }).click()
    await expect(page.getByRole('region', { name: 'Project task detail' })).toBeVisible()
    await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Approve current plan' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: 'Shared plan', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: /Shared plan.*Beta project.*Plan approved/ })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /Shared plan.*Alpha project.*Plan to refine/ })
    ).toBeVisible()
    await page.getByRole('combobox', { name: 'Task project' }).click()
    await expect(page.getByRole('option', { name: 'All projects', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: /refs\/heads\/main/ })).toHaveCount(0)
    await page.getByRole('option', { name: /Alpha project/ }).click()
    await expect(page.getByRole('button', { name: /Shared plan.*Plan to refine/ })).toBeVisible()
    await expect(page.getByText(/ENOENT/)).toHaveCount(0)
    await page.getByText('How tasks work · file locations', { exact: true }).click()
    await expect(page.getByText(/Plans are ordinary task.md/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('project-scope.png') })
  } finally {
    await session.dispose(app)
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
