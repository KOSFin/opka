import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/constants'
import type { ElectronApplication } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit isolated background Electron required')
test.use({ trace: 'retain-on-failure', screenshot: 'only-on-failure' })

test('project-wide kanban supports a complete manual task, safe drafts, and returning to externally updated files', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180000)
  expect(testRepoPath).toBeTruthy()
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-vibe-board-')))
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
    await page.setViewportSize({ width: 1000, height: 760 })
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'Product project',
        parentPath: folderPath
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Product project',
        folderPath
      })
      const response = await window.api.runtime.call({
        method: 'projectTask.init',
        params: {
          worktree: `folder:${folder.id}`,
          expectedExecutionHostId: 'local',
          content: JSON.stringify({
            schema: 1,
            id: 'project-11111111-1111-4111-8111-111111111111',
            repos: { web: 'apps/web', backend: 'services/backend' },
            sources: [{ id: 'project', path: 'docs/work/tasks' }]
          })
        }
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      window.localStorage.removeItem('orca.projectTask.view.v2')
      await window.__store!.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      window.__store!.getState().setActiveView('tasks')
    }, root)
    await page.getByRole('combobox', { name: 'Task project' }).click()
    await page.getByRole('option', { name: /Product project/ }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByLabel('Task board', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Filter repository' })).toHaveCount(0)
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    await page
      .getByRole('textbox', { name: 'Task title', exact: true })
      .fill('Repair the complete login flow')
    await page
      .getByRole('textbox', { name: 'Task description', exact: true })
      .fill('Check the web interface and backend together. Do not deploy.')
    await page.getByRole('button', { name: 'Create plan', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Repair the complete login flow', exact: true })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Plan with agent', exact: true })).toBeVisible()
    await expect(
      sheet.getByText('Check the web interface and backend together. Do not deploy.', {
        exact: true
      })
    ).toBeVisible()
    await sheet.getByRole('button', { name: 'Edit plan', exact: true }).click()
    const editor = sheet.getByRole('textbox', { name: 'Task Markdown source' })
    expect(await editor.inputValue()).toContain('repos: []')
    await editor.fill(`${await editor.inputValue()}\nKeep my unsaved draft\n`)
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    const discard = page.getByRole('dialog', { name: 'Discard unsaved task edits?', exact: true })
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editor).toHaveValue(/Keep my unsaved draft/)
    await sheet.getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect(sheet.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    const card = page
      .getByTestId('project-task-card')
      .filter({ hasText: 'Repair the complete login flow' })
    await card.dragTo(page.getByRole('region', { name: 'In progress', exact: true }))
    await expect(
      page
        .getByRole('region', { name: 'In progress', exact: true })
        .getByTestId('project-task-card')
    ).toHaveCount(1)
    const done = page.getByRole('region', { name: 'Done', exact: true })
    // Scroll before pressing the card: scrolling during a drag moves its press point.
    await done.scrollIntoViewIfNeeded()
    await card.dragTo(done)
    const complete = page.getByRole('dialog', { name: 'Complete task', exact: true })
    await complete
      .getByRole('textbox', { name: 'Review evidence' })
      .fill('Cancelled draft; must not be reused')
    await complete.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(complete).not.toBeVisible()
    await done.scrollIntoViewIfNeeded()
    await card.dragTo(done)
    await expect(complete.getByRole('textbox', { name: 'Review evidence' })).toHaveValue('')
    await complete
      .getByRole('textbox', { name: 'Review evidence' })
      .fill('Manually tested the full login flow. No deployment.')
    await complete.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'Done', exact: true }).getByTestId('project-task-card')
    ).toHaveCount(1)
    await page.evaluate(
      async (samples) => {
        const worktree = `folder:${window.__store!.getState().folderWorkspaces[0].id}`
        for (const [index, sample] of samples.entries()) {
          const result = await window.api.runtime.call({
            method: 'projectTask.create',
            params: {
              worktree,
              expectedExecutionHostId: 'local',
              source: 'project',
              slug: `sample-${index}`,
              content: sample.content
            }
          })
          if (
            !result.ok ||
            !result.result ||
            typeof result.result !== 'object' ||
            !('id' in result.result) ||
            !('revision' in result.result)
          ) {
            throw new Error('Synthetic card creation failed')
          }
          if (sample.phase !== 'draft') {
            const moved = await window.api.runtime.call({
              method: 'projectTask.move',
              params: {
                worktree,
                expectedExecutionHostId: 'local',
                id: result.result.id,
                revision: result.result.revision,
                phase: sample.phase,
                reason: ''
              }
            })
            if (!moved.ok) {
              throw new Error(moved.error.message)
            }
          }
        }
      },
      [
        { title: 'Investigate intermittent worker reconnects', phase: 'draft' },
        { title: 'Refresh public API documentation', phase: 'active' },
        { title: 'Review retry behavior and integration checks', phase: 'review' }
      ].map((entry, index) => ({
        phase: entry.phase,
        content: projectTaskTemplate({
          id: `task-${String(index + 2).repeat(8)}-1111-4111-8111-111111111111`,
          title: entry.title
        })
      }))
    )
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByTestId('project-task-card')).toHaveCount(4)
    await page.screenshot({ path: testInfo.outputPath('vibe-board-desktop.png') })
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
    })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({ path: testInfo.outputPath('vibe-board-dark.png') })
    const taskPath = await page.evaluate(async () => {
      const result = await window.api.runtime.call({
        method: 'projectTask.list',
        params: { worktree: `folder:${window.__store!.getState().folderWorkspaces[0].id}` }
      })
      if (
        !result.ok ||
        !result.result ||
        typeof result.result !== 'object' ||
        !('tasks' in result.result) ||
        !Array.isArray(result.result.tasks)
      ) {
        throw new Error('No tasks')
      }
      const task = result.result.tasks.find(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'title' in entry &&
          entry.title === 'Repair the complete login flow'
      )
      if (!task || !('path' in task)) {
        throw new Error('Task identity lost')
      }
      return String(task.path)
    })
    await page.getByRole('button', { name: 'External trackers', exact: true }).click()
    const file = path.join(root, taskPath)
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replaceAll(
        'Repair the complete login flow',
        'Verify externally updated login'
      )
    )
    await page.getByRole('button', { name: 'Project tasks', exact: true }).click()
    await expect(
      page.getByTestId('project-task-card').filter({ hasText: 'Verify externally updated login' })
    ).toBeVisible()
    await expect(page.getByText('Plan changed', { exact: true })).toBeVisible()
    await page.evaluate(() => {
      const state = window.__store!.getState()
      state.setActiveWorktree(`folder:${state.folderWorkspaces[0].id}`, 'local')
      state.setActiveView('tasks')
    })
    const selectedWorkspace = await page.evaluate(() => window.__store!.getState().activeWorktreeId)
    await page.getByRole('button', { name: 'Open beside chat', exact: true }).click()
    const floating = page.locator('[data-floating-terminal-panel]')
    await expect(floating).toBeVisible()
    await floating.getByRole('button', { name: 'Workspace', exact: true }).click()
    await expect(
      floating.getByRole('button', { name: 'Open project tasks', exact: true })
    ).toBeVisible()
    await expect(floating.locator('[data-floating-project-tasks]')).toHaveCSS('display', 'none')
    await expect(floating.getByRole('button', { name: 'New task', exact: true })).toBeHidden()
    await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({ path: testInfo.outputPath('floating-empty-tasks-dark.png') })
    await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'light' }))
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.screenshot({ path: testInfo.outputPath('floating-empty-tasks-light.png') })
    await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
    await floating.getByRole('button', { name: 'Open project tasks', exact: true }).click()
    await expect(floating.getByTestId('project-task-card')).toHaveCount(4)
    expect(await page.evaluate(() => window.__store!.getState().activeWorktreeId)).toBe(
      selectedWorkspace
    )
    expect(
      await page.evaluate(
        (id) => window.__store!.getState().tabsByWorktree[id] ?? [],
        FLOATING_TERMINAL_WORKTREE_ID
      )
    ).toEqual([])
    await floating
      .getByTestId('project-task-card')
      .filter({ hasText: 'Verify externally updated login' })
      .click()
    await expect(floating.getByRole('region', { name: 'Project task detail' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Verify externally updated login' })).toHaveCount(
      0
    )
    await floating.getByRole('button', { name: 'Edit plan', exact: true }).click()
    const floatingEditor = floating.getByRole('textbox', { name: 'Task Markdown source' })
    await floatingEditor.fill(`${await floatingEditor.inputValue()}\nRetain floating draft\n`)
    await floating.getByRole('button', { name: 'Workspace', exact: true }).click()
    await expect(floatingEditor).toBeHidden()
    await floating.getByRole('button', { name: 'Project tasks', exact: true }).click()
    await expect(floatingEditor).toHaveValue(/Retain floating draft/)
    await floating.getByRole('button', { name: 'Minimize floating workspace', exact: true }).click()
    await expect(floating).toBeHidden()
    await expect(floating.locator('textarea[aria-label="Task Markdown source"]')).toBeHidden()
    await expect(floating.locator('[data-floating-project-tasks]')).toHaveAttribute('inert', '')
    await page.getByRole('button', { name: 'Show floating workspace', exact: true }).click()
    await expect(floatingEditor).toBeVisible()
    await expect(floatingEditor).toHaveValue(/Retain floating draft/)
    await floating.getByRole('button', { name: 'Back to board', exact: true }).click()
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(floatingEditor).toHaveValue(/Retain floating draft/)
    await floating.getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect(floating.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    await floating.getByRole('button', { name: 'Back to board', exact: true }).click()
    await floating.getByRole('button', { name: 'Maximize floating workspace', exact: true }).click()
    await expect(
      floating.getByRole('button', { name: 'Restore floating workspace', exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('floating-tasks-dark.png') })
    await floating.getByRole('button', { name: 'Restore floating workspace', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('floating-tasks-restored.png') })
    await floating.getByRole('button', { name: 'Minimize floating workspace', exact: true }).click()
    await page.evaluate(() => window.__store!.getState().setActiveView('tasks'))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      if (window.__store!.getState().sidebarOpen) {
        window.__store!.getState().toggleSidebar()
      }
    })
    await page.screenshot({ path: testInfo.outputPath('vibe-board-narrow.png') })
  } finally {
    await session.dispose(app)
    rmSync(root, { recursive: true, force: true })
  }
})
