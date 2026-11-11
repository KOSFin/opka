import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree } from './helpers/store'
import { runProcess } from '@orca/process-host'
import type { Page } from '@stablyai/playwright-test'

test.use({
  orcaAppExtraEnv: {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GLAB_TOKEN: '',
    GITLAB_TOKEN: ''
  },
  trace: 'off',
  screenshot: 'off'
})

const evidenceDir = process.env.ORCA_EARLY_RUNNABLE_EVIDENCE_DIR
test.skip(!evidenceDir, 'An explicit disposable evidence directory is required')

async function capture(page: Page, name: string): Promise<void> {
  if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
    throw new Error('Evidence directory must be absolute')
  }
  const session = await page.context().newCDPSession(page)
  try {
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false
    })
    writeFileSync(path.join(evidenceDir, name), Buffer.from(data, 'base64'))
  } finally {
    await session.detach()
  }
}

test('populated project and task navigation stays rendered in a hidden disposable app', async ({
  orcaPage,
  electronApp,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  test.setTimeout(180_000)
  if (!evidenceDir) {
    throw new Error('Missing evidence directory')
  }
  mkdirSync(evidenceDir, { recursive: true })
  const pageErrors: string[] = []
  orcaPage.on('pageerror', (error) => pageErrors.push(error.message))
  await orcaPage.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)

  const syntheticRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-early-cross-')))
  const secondRepoPath = path.join(syntheticRoot, 'second-repository')
  registerPostElectronShutdownCleanup(async () => {
    rmSync(syntheticRoot, { recursive: true, force: true })
  })
  const cloned = await runProcess({
    program: 'git',
    args: ['clone', '--local', testRepoPath, secondRepoPath],
    cwd: syntheticRoot,
    timeoutMs: 10_000
  })
  expect(cloned.code, cloned.stderr).toBe(0)

  const project = await orcaPage.evaluate(
    async ({ repoPath, secondRepoPath }) => {
      const group = await window.api.projectGroups.create({
        name: 'Synthetic project',
        parentPath: repoPath
      })
      const otherGroup = await window.api.projectGroups.create({
        name: 'Other synthetic project',
        parentPath: secondRepoPath
      })
      await window.api.repos.add({ path: secondRepoPath })
      const state = window.__store!.getState()
      await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      await state.awaitLocalRepoCatalogSettlement()
      await state.fetchRepos({ runtimeEnvironmentId: null })
      const repo = window.__store!.getState().repos.find((entry) => entry.path === repoPath)
      const otherRepo = window
        .__store!.getState()
        .repos.find((entry) => entry.path === secondRepoPath)
      if (!repo || !otherRepo) {
        throw new Error('Synthetic repositories not loaded')
      }
      await window.__store!.getState().moveProjectToGroup(repo, group.id)
      await window.__store!.getState().moveProjectToGroup(otherRepo, otherGroup.id)
      window.__store!.getState().setGroupBy('repo')
      return {
        groupId: group.id,
        repoId: repo.id,
        otherGroupId: otherGroup.id,
        otherRepoId: otherRepo.id
      }
    },
    { repoPath: testRepoPath, secondRepoPath }
  )

  const sidebar = orcaPage.locator('[data-worktree-sidebar]')
  const group = sidebar.locator(`[data-project-group-header-id="${project.groupId}"]`)
  const repo = sidebar.locator(`[data-repo-header-id="${project.repoId}"]`)
  await expect(group).toContainText('Synthetic project')
  await expect(repo).toBeVisible()
  await expect(
    sidebar.locator(`[data-project-group-header-id="${project.otherGroupId}"]`)
  ).toContainText('Other synthetic project')
  await expect(sidebar.locator(`[data-repo-header-id="${project.otherRepoId}"]`)).toBeVisible()
  await capture(orcaPage, 'project-repository.png')

  await orcaPage.evaluate(() => window.__store!.getState().setActiveView('tasks'))
  await expect(orcaPage.getByRole('heading', { name: 'Project tasks', exact: true })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Task projects', exact: true }).click()
  const options = orcaPage.getByRole('menuitemcheckbox')
  const labels = await options.allTextContents()
  writeFileSync(
    path.join(evidenceDir, 'project-scope-labels.json'),
    `${JSON.stringify(labels, null, 2)}\n`
  )
  await capture(orcaPage, 'project-scope-picker.png')
  await orcaPage.getByRole('menuitemcheckbox', { name: 'Select all projects' }).click()
  await options.filter({ hasText: path.basename(testRepoPath) }).click()
  await orcaPage.keyboard.press('Escape')
  await orcaPage.getByRole('button', { name: 'Set up task files', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: 'New task', exact: true })).toBeEnabled()
  await orcaPage.getByRole('button', { name: 'New task', exact: true }).click()
  await orcaPage
    .getByRole('textbox', { name: 'Task title', exact: true })
    .fill('Synthetic integration task')
  await orcaPage.getByRole('button', { name: 'Create plan', exact: true }).click()
  await expect(orcaPage.getByRole('region', { name: 'Project task detail' })).toContainText(
    'Synthetic integration task'
  )
  await capture(orcaPage, 'populated-task.png')
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('region', { name: 'Project task detail' })).toBeHidden()

  await orcaPage.getByRole('button', { name: 'Board settings', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Task approval', exact: true }).click()
  const approval = orcaPage.getByRole('region', { name: 'Project task approval mode' })
  await expect(approval).toBeVisible()
  await expect(approval).toContainText('Scoped to this project and execution host')
  await capture(orcaPage, 'delegation-read-only.png')
  await orcaPage.keyboard.press('Escape')

  await orcaPage
    .getByRole('navigation', { name: 'Task sources' })
    .getByRole('button', { name: 'Working copies', exact: true })
    .click()
  await expect(orcaPage.getByRole('button', { name: 'Project tasks', exact: true })).toBeVisible()
  await capture(orcaPage, 'working-copies.png')
  await orcaPage.getByRole('button', { name: 'External trackers', exact: true }).click()
  await expect(
    orcaPage.getByRole('button', { name: 'External trackers', exact: true })
  ).toBeVisible()
  await capture(orcaPage, 'trackers-unconnected.png')

  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(() => window.__store!.getState().setActiveView('terminal'))
  await openFileExplorer(orcaPage)
  await expect(orcaPage.locator('[data-orca-explorer-shell]')).toBeVisible()
  await expect(
    orcaPage.locator('[data-file-explorer-row]').filter({ hasText: 'README.md' })
  ).toBeVisible()
  await capture(orcaPage, 'explorer-seeded-repository.png')

  writeFileSync(
    path.join(evidenceDir, 'page-errors.json'),
    `${JSON.stringify(pageErrors, null, 2)}\n`
  )
  expect(pageErrors).toEqual([])
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})
