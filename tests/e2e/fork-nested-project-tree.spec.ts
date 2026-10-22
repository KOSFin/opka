import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'An explicitly prepared background Electron bundle is required')
test.use({ trace: 'off', screenshot: 'off' })

async function reviewFolder(app: ElectronApplication, page: Page, root: string): Promise<void> {
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
      bookmarks: []
    })
  }, root)
  await page.evaluate(() => window.__store!.getState().openModal('add-repo'))
  await page
    .getByRole('dialog', { name: /Add a project/i })
    .getByRole('button', { name: /Browse folder/i })
    .click()
  await expect(page.getByRole('dialog', { name: /Import repositories from folder/i })).toBeVisible()
}

test('imports a real folder tree, preserves branches and group IDs, and restores collapse after restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  expect(testRepoPath).toBeTruthy()
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-fork-tree-')))
  const relativePaths = [
    'apps/web-client',
    'services/payments/api',
    'services/worker',
    'embedded',
    'embedded/module'
  ]
  const projectPaths = relativePaths.map((relative) => path.join(root, relative))
  for (const [index, directory] of projectPaths.entries()) {
    mkdirSync(directory, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', `audit-${index}`], { cwd: directory })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Audit',
        '-c',
        'user.email=audit@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Audit fixture'
      ],
      { cwd: directory }
    )
  }
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
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    await reviewFolder(app, page, root)
    const review = page.getByRole('dialog', { name: /Import repositories from folder/i })
    await expect(review.getByText('services/payments/api', { exact: true })).toBeVisible()
    await expect(review.getByText('embedded/module', { exact: true })).toBeVisible()
    await review.getByLabel('Group name', { exact: true }).fill('Iteration tree')
    await page.screenshot({ path: testInfo.outputPath('import-review.png') })
    await review.getByRole('button', { name: 'Yes, import as group', exact: true }).click()
    await expect(review).toBeHidden({ timeout: 30_000 })
    await page.evaluate(async () => {
      const state = window.__store!.getState()
      state.setGroupBy('repo')
      state.setProjectOrderBy('manual')
      await state.fetchProjectGroups({ runtimeEnvironmentId: null })
      await state.fetchRepos({ runtimeEnvironmentId: null })
    })
    const groups = await page.evaluate(() => window.api.projectGroups.list())
    const rootGroup = groups.find((group) => group.parentPath === root)
    const services = groups.find((group) => group.name === 'services')
    const payments = groups.find((group) => group.name === 'payments')
    if (!rootGroup || !services || !payments) {
      throw new Error('Missing imported folder groups')
    }
    const groupHeader = (id: string) => page.locator(`[data-project-group-header-id="${id}"]`)
    await expect(groupHeader(rootGroup.id)).toContainText('Iteration tree')
    await expect(groupHeader(services.id)).toHaveCount(0)
    await expect(groupHeader(payments.id)).toHaveCount(0)
    const embedded = groups.find((group) => group.parentPath === path.join(root, 'embedded'))
    if (!embedded) {
      throw new Error('Missing folder containing its own Git repository')
    }
    const sidebar = page.locator('[data-worktree-sidebar]')
    const ownGit = sidebar
      .locator('[data-repo-header-id]')
      .filter({ has: page.getByRole('button', { name: 'Open repository embedded', exact: true }) })
    await expect(ownGit).toHaveCount(1)
    await expect(sidebar.getByText('Root Git', { exact: true })).toHaveCount(0)
    await expect(
      sidebar.getByRole('button', { name: 'Open repository embedded/module', exact: true })
    ).toBeVisible()
    const nestedIndent = await ownGit.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft)
    )
    const containerIndent = await groupHeader(rootGroup.id).evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft)
    )
    expect(nestedIndent).toBeGreaterThan(containerIndent)
    await groupHeader(rootGroup.id)
      .getByRole('button', { name: 'Collapse Iteration tree', exact: true })
      .click()
    await expect(ownGit).toHaveCount(0)
    await groupHeader(rootGroup.id)
      .getByRole('button', { name: 'Expand Iteration tree', exact: true })
      .click()
    await expect(ownGit).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('project-tree.png') })
    const imported = await page.evaluate(() => window.api.repos.list())
    expect(imported.filter((repo) => projectPaths.includes(repo.path))).toHaveLength(
      projectPaths.length
    )
    for (const [index, directory] of projectPaths.entries()) {
      expect(
        execFileSync('git', ['branch', '--show-current'], {
          cwd: directory,
          encoding: 'utf8'
        }).trim()
      ).toBe(`audit-${index}`)
    }
    const orderedRepo = imported.find((repo) => repo.path === projectPaths[0])
    if (!orderedRepo) {
      throw new Error('Imported repository unavailable')
    }
    await page.evaluate(async (repoId) => {
      await window.api.repos.update({ repoId, updates: { projectGroupOrder: 42 } })
    }, orderedRepo.id)
    await reviewFolder(app, page, root)
    await page
      .getByRole('dialog', { name: /Import repositories from folder/i })
      .getByRole('button', { name: 'Yes, import as group', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: /Import repositories from folder/i })).toBeHidden(
      { timeout: 30_000 }
    )
    const after = await page.evaluate(() => window.api.projectGroups.list())
    expect(after.map((group) => group.id).sort()).toEqual(groups.map((group) => group.id).sort())
    const afterRepos = await page.evaluate(() => window.api.repos.list())
    expect(afterRepos.find((repo) => repo.id === orderedRepo.id)?.projectGroupOrder).toBe(42)
    await groupHeader(rootGroup.id)
      .getByRole('button', { name: 'Collapse Iteration tree', exact: true })
      .click()
    await expect(ownGit).toHaveCount(0)
    await session.close(app)
    app = undefined
    launched = await session.launch({ executablePath })
    app = launched.app
    const restored = launched.page
    const setupTip = restored.locator('[data-setup-script-prompt-layer]')
    if (await setupTip.isVisible()) {
      await setupTip.getByRole('button', { name: /Dismiss/i }).click()
    }
    await expect(
      restored.getByRole('button', { name: 'Expand Iteration tree', exact: true })
    ).toBeVisible()
    await expect(
      restored.getByRole('button', { name: 'Open repository embedded/module', exact: true })
    ).toHaveCount(0)
    await restored.getByRole('button', { name: 'Expand Iteration tree', exact: true }).click()
    await expect(
      restored.getByRole('button', { name: 'Open repository embedded/module', exact: true })
    ).toBeVisible()
    writeFileSync(
      testInfo.outputPath('tree-result.json'),
      JSON.stringify(
        {
          repoCount: projectPaths.length,
          groups: groups.map(({ name, parentGroupId, id }) => ({ name, parentGroupId, id })),
          indentation: [containerIndent, nestedIndent],
          reimportPreservedIds: true,
          restartPreservedCollapse: true
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  } finally {
    await session.dispose(app)
    rmSync(root, { recursive: true, force: true })
  }
})
