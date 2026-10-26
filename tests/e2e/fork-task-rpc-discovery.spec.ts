import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit background Electron required')
test.use({ trace: 'off', screenshot: 'off' })

async function rpc(page: Page, method: string, params: Record<string, unknown>) {
  const reply = await page.evaluate((request) => window.api.runtime.call(request), {
    method,
    params
  })
  if (!reply.ok) {
    throw new Error(reply.error.message)
  }
  return reply.result
}

test('discovers a task initialized through RPC and opens its saved report without a model', async ({
  testRepoPath
}, testInfo) => {
  expect(testRepoPath).toBeTruthy()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opka-rpc-task-ui-')))
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  let app: ElectronApplication | undefined
  let page: Page | undefined
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    page = launched.page
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    const worktree = await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'RPC task discovery',
        parentPath: folderPath
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'RPC task discovery',
        folderPath
      })
      await window.__store!.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      return `folder:${folder.id}`
    }, root)
    await page.getByRole('combobox', { name: 'Task project' }).click()
    await page.getByRole('option', { name: /RPC task discovery/ }).click()
    await expect(page.getByRole('button', { name: 'Set up task files', exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Task project' }).click()
    await page.getByRole('option', { name: 'All projects', exact: true }).click()
    await rpc(page, 'projectTask.init', { worktree, expectedExecutionHostId: 'local' })
    for (const file of [
      '.agents/skills/opka-tasks/SKILL.md',
      '.claude/skills/opka-tasks/SKILL.md',
      '.orca/task-agent-settings.json'
    ]) {
      unlinkSync(join(root, file))
    }
    await rpc(page, 'projectTask.create', {
      worktree,
      source: 'project',
      slug: 'addition',
      expectedExecutionHostId: 'local',
      content: projectTaskTemplate({ id: `task-${randomUUID()}`, title: 'Исправить сложение' })
    })
    const reports = join(root, 'docs', 'work', 'tasks', 'addition', 'reports')
    mkdirSync(reports, { recursive: true })
    writeFileSync(
      join(reports, 'synthetic.md'),
      '# Synthetic report\nsum: UI fixture, no model inference.\n'
    )
    writeFileSync(
      testInfo.outputPath('rpc-task-catalog.json'),
      JSON.stringify(await rpc(page, 'projectTask.catalog', {}))
    )
    await page.evaluate(() => window.__store!.getState().setActiveView('tasks'))
    await page.getByRole('combobox', { name: 'Task project' }).click()
    await page.getByRole('option', { name: /RPC task discovery/ }).click()
    await page.getByRole('button', { name: 'Board settings', exact: true }).click()
    let settings = page.getByRole('dialog', { name: 'Board settings', exact: true })
    await expect(settings.getByRole('status')).toHaveText('Enabled')
    await expect(settings.getByRole('switch', { name: 'Agent task workflow' })).toBeChecked()
    await page.screenshot({ path: testInfo.outputPath('board-settings-enabled.png') })
    await settings.getByRole('switch', { name: 'Agent task workflow' }).click()
    await expect(settings.getByRole('status')).toHaveText('Disabled')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await session.close(app)
    const restarted = await session.launch({ executablePath })
    app = restarted.app
    page = restarted.page
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await page.evaluate(() => window.__store!.getState().setActiveView('tasks'))
    await page.getByRole('button', { name: 'Board settings', exact: true }).click()
    settings = page.getByRole('dialog', { name: 'Board settings', exact: true })
    await expect(settings.getByRole('status')).toHaveText('Disabled')
    await expect(settings.getByRole('switch', { name: 'Agent task workflow' })).not.toBeChecked()
    await settings.getByRole('switch', { name: 'Agent task workflow' }).click()
    await expect(settings.getByRole('status')).toHaveText('Enabled')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('rpc-task-board.png') })
    await page.getByRole('button', { name: /Исправить сложение/ }).click({ timeout: 10000 })
    await page.getByRole('button', { name: 'Reports & notes', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Task reports and notes' })).toContainText('sum')
    await page.screenshot({ path: testInfo.outputPath('rpc-task-report.png') })
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: testInfo.outputPath('rpc-task-failure.png') })
      writeFileSync(testInfo.outputPath('rpc-task-dom.txt'), await page.locator('body').innerText())
    }
    throw error
  } finally {
    await session.dispose(app)
    rmSync(root, { recursive: true, force: true })
  }
})
