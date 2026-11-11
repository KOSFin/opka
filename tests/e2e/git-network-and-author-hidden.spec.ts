import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import { captureHiddenGitScreenshot, runIsolatedFixtureGit } from './helpers/git-synthetic-journey'
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

const evidenceDir = process.env.ORCA_GIT_HIDDEN_EVIDENCE_DIR
if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
  throw new Error('ORCA_GIT_HIDDEN_EVIDENCE_DIR must be an absolute private evidence path')
}

async function measureTouchTarget(
  page: Page,
  name: string
): Promise<{ width: number; height: number }> {
  const bounds = await page.getByRole('button', { name, exact: true }).boundingBox()
  expect(bounds, `${name} has a rendered box`).not.toBeNull()
  return { width: bounds?.width ?? 0, height: bounds?.height ?? 0 }
}

test('hidden clone picker shows host scoped synthetic metadata without ambient fallback', async ({
  electronApp,
  orcaPage: page
}) => {
  test.setTimeout(180_000)
  mkdirSync(evidenceDir, { recursive: true })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  const hiddenBefore = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  expect(hiddenBefore).toBe(true)
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((window) => window.isVisible())) {
      throw new Error('Git journey revealed an Electron window')
    }
    ipcMain.removeHandler('gitlab:listNetworkProfiles')
    ipcMain.handle('gitlab:listNetworkProfiles', () => [
      {
        id: 'a'.repeat(64),
        host: 'gitlab.example',
        user: 'alice',
        generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      },
      {
        id: 'b'.repeat(64),
        host: 'other.example',
        user: 'bob',
        generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      }
    ])
    ipcMain.removeHandler('gh:listCloneAccounts')
    ipcMain.handle('gh:listCloneAccounts', () => ({
      capability: 'supported',
      accounts: [
        {
          host: 'github.com',
          user: 'octocat',
          active: true,
          envToken: null,
          source: 'keyring',
          scopes: []
        },
        {
          host: 'github.com',
          user: 'env-only',
          active: false,
          envToken: 'GITHUB_TOKEN',
          source: 'env',
          scopes: []
        }
      ]
    }))
  })
  await page.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  await openSidebarProjectDialog(page)
  await page
    .getByRole('dialog', { name: /Add a project/i })
    .getByRole('button', { name: /Clone from URL/i })
    .click()
  const dialog = page.getByRole('dialog', { name: /Clone from URL/i })
  await dialog
    .getByPlaceholder('https://github.com/user/repo.git')
    .fill('https://gitlab.example/team/repo.git')
  await dialog
    .getByPlaceholder('/path/to/destination')
    .fill(path.join(os.tmpdir(), 'synthetic-git-clone-target'))
  await dialog.getByRole('combobox', { name: 'Git network account provider' }).click()
  await page.getByRole('option', { name: 'GitLab profile' }).click()
  await dialog.getByRole('combobox', { name: 'Verified Git network account' }).click()
  await expect(page.getByRole('option', { name: 'alice · gitlab.example' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'bob · other.example' })).toHaveCount(0)
  await page.getByRole('option', { name: 'alice · gitlab.example' }).click()
  await expect(dialog.getByRole('button', { name: /^Clone$/ })).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 700 })
  await captureHiddenGitScreenshot(page, evidenceDir, 'gitlab-profile-picker-light.png')
  const lightModalBounds = await dialog.boundingBox()
  await dialog.getByRole('button', { name: 'Clone', exact: true }).scrollIntoViewIfNeeded()
  const lightCloneBounds = await dialog
    .getByRole('button', { name: 'Clone', exact: true })
    .boundingBox()
  await dialog.getByRole('button', { name: 'Back', exact: true }).scrollIntoViewIfNeeded()
  const lightBackBounds = await dialog
    .getByRole('button', { name: 'Back', exact: true })
    .boundingBox()
  const touchTargets = {
    add: await measureTouchTarget(page, 'Add verified GitLab profile'),
    remove: await measureTouchTarget(page, 'Remove selected profile…'),
    refresh: await measureTouchTarget(page, 'Refresh accounts'),
    clone: await measureTouchTarget(page, 'Clone')
  }

  await dialog
    .getByPlaceholder('https://github.com/user/repo.git')
    .fill('https://other.example/team/repo.git')
  await expect(dialog.getByRole('button', { name: /^Clone$/ })).toBeDisabled()
  await dialog
    .getByPlaceholder('https://github.com/user/repo.git')
    .fill('https://github.com/acme/repo.git')
  await dialog.getByRole('combobox', { name: 'Git network account provider' }).click()
  await page.getByRole('option', { name: 'GitHub account' }).click()
  await dialog.getByRole('combobox', { name: 'Verified Git network account' }).click()
  await expect(page.getByRole('option', { name: 'octocat · github.com' })).toBeVisible()
  await expect(page.getByRole('option', { name: /env-only/ })).toHaveCount(0)
  await page.getByRole('option', { name: 'octocat · github.com' }).click()
  await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
  await captureHiddenGitScreenshot(page, evidenceDir, 'github-account-picker-dark-narrow.png')
  const providerBounds = await dialog
    .getByRole('combobox', { name: 'Git network account provider' })
    .boundingBox()
  const accountBounds = await dialog
    .getByRole('combobox', { name: 'Verified Git network account' })
    .boundingBox()
  touchTargets.refresh = await measureTouchTarget(page, 'Refresh accounts')
  const touchMetrics = {
    ...touchTargets,
    provider: { width: providerBounds?.width ?? 0, height: providerBounds?.height ?? 0 },
    account: { width: accountBounds?.width ?? 0, height: accountBounds?.height ?? 0 }
  }
  writeFileSync(
    path.join(evidenceDir, 'git-network-touch-targets.json'),
    `${JSON.stringify(touchMetrics, null, 2)}\n`
  )
  for (const [name, bounds] of Object.entries(touchMetrics)) {
    expect(bounds.height, `${name} touch height`).toBeGreaterThanOrEqual(44)
    expect(bounds.width, `${name} touch width`).toBeGreaterThanOrEqual(44)
  }
  await dialog.getByRole('button', { name: 'Clone', exact: true }).scrollIntoViewIfNeeded()
  const cloneBounds = await dialog.getByRole('button', { name: 'Clone', exact: true }).boundingBox()
  const backBounds = await dialog.getByRole('button', { name: 'Back', exact: true }).boundingBox()
  const closeBounds = await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox()
  const modalBounds = await dialog.boundingBox()
  const narrowGeometry = {
    lightModalBounds,
    lightCloneBounds,
    lightBackBounds,
    cloneBounds,
    backBounds,
    closeBounds,
    modalBounds
  }
  writeFileSync(
    path.join(evidenceDir, 'git-network-narrow-geometry.json'),
    `${JSON.stringify(narrowGeometry, null, 2)}\n`
  )
  expect(cloneBounds).not.toBeNull()
  expect((cloneBounds?.y ?? 701) + (cloneBounds?.height ?? 0)).toBeLessThanOrEqual(700)
  expect(lightModalBounds).not.toBeNull()
  expect(lightModalBounds?.y ?? -1).toBeGreaterThanOrEqual(0)
  expect((lightModalBounds?.y ?? 701) + (lightModalBounds?.height ?? 0)).toBeLessThanOrEqual(700)
  expect((lightCloneBounds?.y ?? 701) + (lightCloneBounds?.height ?? 0)).toBeLessThanOrEqual(700)
  expect(lightBackBounds?.y ?? -1).toBeGreaterThanOrEqual(0)
  expect(backBounds).not.toBeNull()
  expect(closeBounds).not.toBeNull()
  expect(backBounds?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(closeBounds?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(closeBounds?.width ?? 0).toBeGreaterThanOrEqual(44)
  const hiddenAfter = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  writeFileSync(
    path.join(evidenceDir, 'git-network-hidden-page-errors.json'),
    `${JSON.stringify({ hiddenBefore, hiddenAfter, pageErrors }, null, 2)}\n`
  )
  expect(pageErrors).toEqual([])
  expect(hiddenAfter).toBe(true)
})

test('two disposable repositories keep commit authors independent of network account UI', async ({
  electronApp,
  orcaPage: page,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  test.setTimeout(180_000)
  mkdirSync(evidenceDir, { recursive: true })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const hiddenBefore = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  expect(hiddenBefore).toBe(true)
  const secondRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-git-author-'))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(secondRoot, { recursive: true, force: true })
  )
  const gitHome = path.join(secondRoot, 'git-home')
  const secondPath = path.join(secondRoot, 'second')
  const folderPath = path.join(secondRoot, 'folder')
  mkdirSync(gitHome)
  mkdirSync(secondPath)
  mkdirSync(folderPath)
  await runIsolatedFixtureGit(secondPath, gitHome, ['init', '-q'])
  await runIsolatedFixtureGit(secondPath, gitHome, ['config', '--local', 'user.name', 'Author B'])
  await runIsolatedFixtureGit(secondPath, gitHome, [
    'config',
    '--local',
    'user.email',
    'b@example.test'
  ])
  await runIsolatedFixtureGit(testRepoPath, gitHome, ['config', '--local', 'user.name', 'Author A'])
  await runIsolatedFixtureGit(testRepoPath, gitHome, [
    'config',
    '--local',
    'user.email',
    'a@example.test'
  ])
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('gitlab:listNetworkProfiles')
    ipcMain.handle('gitlab:listNetworkProfiles', () => [])
    ipcMain.removeHandler('gh:listBindableAccounts')
    ipcMain.handle('gh:listBindableAccounts', () => ({ capability: 'supported', accounts: [] }))
  })
  const repos = await page.evaluate(
    async ({ firstPath, secondPath }) => {
      await window.api.repos.add({ path: secondPath })
      const state = window.__store!.getState()
      await state.fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
      await window.__store!.getState().awaitLocalRepoCatalogSettlement()
      const local = (path: string) =>
        window
          .__store!.getState()
          .repos.find(
            (repo) => repo.path === path && repo.executionHostId === 'local' && !repo.connectionId
          )
      const first = local(firstPath)
      const second = local(secondPath)
      if (!first || !second) {
        throw new Error('Exact local disposable repositories not loaded')
      }
      state.updateSettings({ uiLanguage: 'en' })
      return {
        first: { id: first.id, path: first.path, executionHostId: first.executionHostId },
        second: { id: second.id, path: second.path, executionHostId: second.executionHostId }
      }
    },
    { firstPath: testRepoPath, secondPath }
  )
  writeFileSync(
    path.join(evidenceDir, 'git-author-local-repo-owners.json'),
    `${JSON.stringify(repos, null, 2)}\n`
  )
  const openSettings = async (repoId: string): Promise<void> => {
    await page.evaluate((id) => {
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'repo', repoId: id })
      state.openSettingsPage()
    }, repoId)
    await expect(page.locator(`[data-settings-section="repo-${repoId}"]`)).toBeVisible()
  }
  await openSettings(repos.first.id)
  await expect(page.getByLabel('Author name')).toHaveValue('Author A')
  await expect(page.getByLabel('Author email')).toHaveValue('a@example.test')
  await expect(page.getByText('Git network account', { exact: true }).first()).toBeVisible()
  await page.getByLabel('Author name').scrollIntoViewIfNeeded()
  await captureHiddenGitScreenshot(page, evidenceDir, 'repo-a-author.png')
  await page.getByText('Git network account', { exact: true }).first().scrollIntoViewIfNeeded()
  await captureHiddenGitScreenshot(page, evidenceDir, 'repo-a-network.png')
  await openSettings(repos.second.id)
  await expect(page.getByLabel('Author name')).toHaveValue('Author B')
  await expect(page.getByLabel('Author email')).toHaveValue('b@example.test')
  await page.getByLabel('Author name').fill('Author B Revised')
  await page.getByRole('button', { name: 'Save author' }).click()
  await expect(page.getByLabel('Author name')).toHaveValue('Author B Revised')
  await expect
    .poll(() => runIsolatedFixtureGit(secondPath, gitHome, ['config', '--local', 'user.name']))
    .toBe('Author B Revised')
  expect(
    await runIsolatedFixtureGit(testRepoPath, gitHome, ['config', '--local', 'user.name'])
  ).toBe('Author A')
  await captureHiddenGitScreenshot(page, evidenceDir, 'repo-b-author-readback.png')
  const folder = await page.evaluate(async (folderPath) => {
    const added = await window.api.repos.add({ path: folderPath, kind: 'folder' })
    if ('error' in added) {
      throw new Error(added.error)
    }
    await window.__store!.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
    await window.__store!.getState().awaitLocalRepoCatalogSettlement()
    const repo = window
      .__store!.getState()
      .repos.find(
        (entry) =>
          entry.id === added.repo.id &&
          entry.path === folderPath &&
          entry.executionHostId === 'local'
      )
    if (!repo) {
      throw new Error('Exact local folder workspace not loaded')
    }
    return { id: repo.id, path: repo.path, executionHostId: repo.executionHostId, kind: repo.kind }
  }, folderPath)
  writeFileSync(
    path.join(evidenceDir, 'git-folder-owner.json'),
    `${JSON.stringify(folder, null, 2)}\n`
  )
  await openSettings(folder.id)
  const folderSettings = page.locator(`[data-settings-section="repo-${folder.id}"]`)
  await expect(folderSettings.getByText('Commit author', { exact: true })).toHaveCount(0)
  await expect(folderSettings.getByText('Git network account', { exact: true })).toHaveCount(0)
  await captureHiddenGitScreenshot(page, evidenceDir, 'folder-without-git-author-or-network.png')
  const hiddenAfter = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((window) => !window.isVisible())
  )
  writeFileSync(
    path.join(evidenceDir, 'git-author-folder-hidden-page-errors.json'),
    `${JSON.stringify({ hiddenBefore, hiddenAfter, pageErrors }, null, 2)}\n`
  )
  expect(pageErrors).toEqual([])
  expect(hiddenAfter).toBe(true)
})
