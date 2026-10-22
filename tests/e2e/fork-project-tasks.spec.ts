import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'An explicitly prepared background Electron bundle is required')
test.use({ trace: 'off', screenshot: 'off' })

async function openTaskPage(page: Page, root?: string) {
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  if (root) {
    await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'Task fixture',
        parentPath: folderPath
      })
      await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Task fixture',
        folderPath
      })
      await window.__store!.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
    }, root)
  }
  await page.evaluate(() => window.__store!.getState().setActiveView('tasks'))
  await expect(page.getByRole('heading', { name: 'Project tasks', exact: true })).toBeVisible()
  if (root) {
    await page.getByRole('combobox', { name: 'Task project' }).click()
    await page.getByRole('option', { name: /Task fixture/ }).click()
  }
}

test('file tasks edit, approve, archive, conflict safely, and survive a hidden app restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  expect(testRepoPath).toBeTruthy()
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-fork-task-gui-')))
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1'
  })
  let app: ElectronApplication | undefined
  try {
    let launched = await session.launch({ executablePath })
    app = launched.app
    const page = launched.page
    await openTaskPage(page, root)
    await page.getByRole('button', { name: 'Set up task files', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    await page
      .getByRole('textbox', { name: 'Task title', exact: true })
      .fill('Audit file-backed tasks')
    await page.getByRole('button', { name: 'Create plan', exact: true }).click()
    const detail = page.getByRole('region', { name: 'Project task detail' })
    await detail.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await expect(detail.getByRole('textbox', { name: 'Rename task' })).toHaveValue(
      'Audit file-backed tasks'
    )
    await detail.getByRole('button', { name: 'Edit plan', exact: true }).click()
    const editor = detail.getByRole('textbox', { name: 'Task Markdown source' })
    const original = await editor.inputValue()
    await editor.fill(
      `${original}\n## Custom section\nPreserve this evidence.\n\n[Local evidence](notes.md)\n\n[Outside project](file:///outside-project-proof.md)\n`
    )
    await detail.getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect(detail.getByRole('button', { name: 'Save plan', exact: true })).toBeDisabled()
    await detail.getByRole('button', { name: 'Approve plan', exact: true }).click()
    const approval = page.getByRole('dialog', { name: 'Approve current plan' })
    await approval.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(approval).toBeHidden()
    await expect(detail.getByText('Task information · ready', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('tasks-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      if (window.__store!.getState().sidebarOpen) {
        window.__store!.getState().toggleSidebar()
      }
    })
    await page.screenshot({ path: testInfo.outputPath('tasks-narrow.png') })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.evaluate(() => {
      if (!window.__store!.getState().sidebarOpen) {
        window.__store!.getState().toggleSidebar()
      }
    })
    await detail.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Archive task' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: /Audit file-backed tasks.*archived/ })
    ).toHaveCount(0)
    await page.getByText('View & filters', { exact: true }).click()
    await page.getByRole('button', { name: 'Include archived', exact: true }).click()
    await page.getByRole('button', { name: /Audit file-backed tasks.*Archived/ }).click()
    await detail.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Restore', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Restore task' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await detail.getByRole('button', { name: 'Edit plan', exact: true }).click()
    const taskPath = await page.evaluate(async () => {
      const select = await window.api.runtime.call({
        method: 'projectTask.list',
        params: { worktree: `folder:${window.__store!.getState().folderWorkspaces[0].id}` }
      })
      if (
        !select.ok ||
        !select.result ||
        typeof select.result !== 'object' ||
        !('tasks' in select.result) ||
        !Array.isArray(select.result.tasks)
      ) {
        throw new Error('No task documents')
      }
      return String(select.result.tasks[0].path)
    })
    await editor.fill(`${await editor.inputValue()}\nLocal unsaved draft\n`)
    const documentPath = path.join(root, taskPath)
    writeFileSync(
      path.join(path.dirname(documentPath), 'notes.md'),
      '# Evidence\n\nSynthetic local report\n'
    )
    writeFileSync(
      documentPath,
      `${readFileSync(documentPath, 'utf8')}\nExternally saved revision\n`
    )
    await detail.getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect(detail.getByRole('alert')).toContainText(/conflict/)
    await expect(editor).toHaveValue(/Local unsaved draft/)
    await detail.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await expect(editor).toHaveValue(/Externally saved revision/)
    await session.close(app)
    app = undefined
    launched = await session.launch({ executablePath })
    app = launched.app
    await openTaskPage(launched.page)
    await expect(
      launched.page.getByRole('button', { name: /Audit file-backed tasks/ })
    ).toBeVisible()
    await launched.page.getByRole('button', { name: /Audit file-backed tasks/ }).click()
    await launched.page.getByRole('button', { name: 'Plan', exact: true }).click()
    await expect(launched.page.getByText('Preserve this evidence.', { exact: true })).toBeVisible()
    await expect(launched.page.getByText(/plan changed/i).first()).toBeVisible()
    await launched.page.getByRole('link', { name: 'Outside project', exact: true }).click()
    await expect(launched.page.getByRole('alert')).toContainText(/outside the project/)
    await launched.page.getByRole('link', { name: 'Local evidence', exact: true }).click()
    await expect(
      launched.page.getByText('Synthetic local report', { exact: false }).first()
    ).toBeVisible()
    await launched.page.evaluate(() => window.__store!.getState().setActiveView('tasks'))
    await expect(
      launched.page.getByRole('heading', { name: 'Project tasks', exact: true })
    ).toBeVisible()
    const taskSheet = launched.page.getByRole('dialog', {
      name: 'Audit file-backed tasks',
      exact: true
    })
    if (await taskSheet.isVisible()) {
      await taskSheet.getByRole('button', { name: 'Close', exact: true }).click()
    }
    await launched.page.getByRole('button', { name: 'External trackers', exact: true }).click()
    await expect(
      launched.page.getByRole('heading', { name: 'Project tasks', exact: true })
    ).toHaveCount(0)
  } finally {
    if (app) {
      await session.dispose(app)
    }
    rmSync(root, { recursive: true, force: true })
  }
})
