import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import type { ElectronApplication } from '@stablyai/playwright-test'
import {
  installTaskTimingProbe,
  readTaskTimingProbe
} from '../../config/scripts/fork-acceptance-navigation.mjs'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit background Electron required')
test.use({ trace: 'off', screenshot: 'off' })

test('opens an overall project, chooses repository Git, and restores host collapse', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180000)
  expect(testRepoPath).toBeTruthy()
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-navigation-')))
  for (const relative of ['apps/web', 'services/backend']) {
    const cwd = path.join(root, relative)
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd })
    execFileSync('git', ['config', 'user.name', 'Audit'], { cwd })
    execFileSync('git', ['config', 'user.email', 'audit@localhost'], { cwd })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd })
    writeFileSync(path.join(cwd, 'fixture.txt'), 'Original fixture\n')
    execFileSync('git', ['add', 'fixture.txt'], { cwd })
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
        'Fixture'
      ],
      { cwd }
    )
    if (relative === 'apps/web') {
      for (let i = 0; i < 18; i++) {
        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', `History fixture ${i}`], {
          cwd
        })
      }
    }
    writeFileSync(path.join(cwd, 'fixture.txt'), 'Changed fixture\n')
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
    await installTaskTimingProbe(app, [
      'repos:getBaseRefDefault',
      'git:branchCompare',
      'runtime:call',
      'runtimeEnvironments:call'
    ])
    const page = launched.page
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    const prepared = await page.evaluate(async (root) => {
      const scan = await window.api.projectGroups.scanNested({ path: root })
      const imported = await window.api.projectGroups.importNested({
        parentPath: root,
        groupName: 'Navigation project',
        mode: 'group',
        projectPaths: scan.repos.map((repo) => repo.path)
      })
      if (!imported.group) {
        throw new Error('Project group was not imported')
      }
      const state = window.__store!.getState()
      await state.fetchProjectGroups({ runtimeEnvironmentId: null })
      await state.fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      await state.fetchRepos({ runtimeEnvironmentId: null })
      await state.fetchAllWorktrees()
      state.setGroupBy('repo')
      state.setProjectOrderBy('manual')
      return { groupId: imported.group.id, activeWorktreeId: state.activeWorktreeId }
    }, root)
    const sidebar = page.locator('[data-worktree-sidebar]')
    const host = sidebar.locator('[data-host-header-drag-id="local"]')
    await expect(host).toBeVisible()
    await expect(host.locator('svg.lucide-server')).toHaveCount(0)
    const projectToggle = page.getByRole('button', {
      name: 'Collapse Navigation project',
      exact: true
    })
    await projectToggle.locator('svg').click()
    await expect(sidebar.getByText('apps/web', { exact: true })).toHaveCount(0)
    const expandProject = page.getByRole('button', {
      name: 'Expand Navigation project',
      exact: true
    })
    await expandProject.focus()
    await page.keyboard.press('Enter')
    await expect(sidebar.getByText('apps/web', { exact: true })).toBeVisible()
    await expect(sidebar.getByText('apps', { exact: true })).toHaveCount(0)
    await sidebar.getByRole('button', { name: 'Collapse apps/web', exact: true }).click()
    await expect(
      sidebar.getByRole('button', { name: 'Expand apps/web', exact: true })
    ).toBeVisible()
    await sidebar.getByRole('button', { name: 'Expand apps/web', exact: true }).click()
    await page.getByRole('button', { name: 'New chat in Navigation project', exact: true }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menu').getByRole('status')).toHaveCount(0)
    await expect(page.getByRole('menu').getByRole('menuitem')).not.toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.__store!.getState().activeWorktreeId))
      .toBe(prepared.activeWorktreeId)
    await expect(page.locator('[data-terminal-tab-id]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-terminal-tab-id]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Open project Navigation project', exact: true }).click()
    await expect(page.getByRole('dialog', { name: /Create folder workspace/i })).toHaveCount(0)
    await expect(sidebar.locator('[aria-current="page"][data-worktree-id]')).toHaveAttribute(
      'data-worktree-id',
      /^folder:/
    )
    await page.getByRole('button', { name: 'New chat in Navigation project', exact: true }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menu').getByRole('menuitem')).not.toHaveCount(0)
    await page.keyboard.press('Escape')
    const projectTitle = page.getByRole('button', {
      name: 'Open project Navigation project',
      exact: true
    })
    expect(await projectTitle.evaluate((node) => getComputedStyle(node).cursor)).toBe('pointer')
    await page.evaluate(() => {
      window.__store!.getState().setRightSidebarTab('source-control')
      if (!window.__store!.getState().rightSidebarOpen) {
        window.__store!.getState().toggleRightSidebar()
      }
    })
    const overview = page.getByRole('region', { name: 'Project repositories' })
    const webToggle = overview.getByRole('button', { name: 'Source Control for web', exact: true })
    const backendToggle = overview.getByRole('button', {
      name: 'Source Control for backend',
      exact: true
    })
    await expect(webToggle).toBeVisible()
    await expect(backendToggle).toBeVisible()
    await backendToggle.click()
    await expect(backendToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(overview.locator('[data-source-control-repository]')).toHaveCount(1)
    await webToggle.click()
    await expect(webToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(overview.locator('[data-source-control-repository]')).toHaveCount(1)
    await expect(overview.getByText('Comparing against', { exact: false })).toHaveCount(0)
    const readCount = (rows: { channel: string; method?: string }[]) =>
      rows.filter(
        (entry) =>
          ['repos:getBaseRefDefault', 'git:branchCompare'].includes(entry.channel) ||
          ['git.branchCompare', 'repo.baseRefDefault'].includes(entry.method ?? '')
      ).length
    const beforeSwitch = readCount(await readTaskTimingProbe(app))
    const switchStart = Date.now()
    await backendToggle.click()
    await expect(backendToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(overview.getByText('Comparing against', { exact: false })).toHaveCount(0)
    await webToggle.click()
    await expect(webToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(overview.getByText('Comparing against', { exact: false })).toHaveCount(0)
    const extraReads = readCount(await readTaskTimingProbe(app)) - beforeSwitch
    if (extraReads) {
      console.log(JSON.stringify({ gitReads: await readTaskTimingProbe(app) }))
    }
    console.log(
      JSON.stringify({
        gitWarmSwitchMs: Date.now() - switchStart,
        extraBaseAndCompareReads: extraReads
      })
    )
    if (process.env.ORCA_ASSERT_GIT_SWITCH === '1') {
      expect(extraReads).toBe(0)
    }
    const webPanel = overview
      .locator('[data-source-control-repository]')
      .filter({ has: page.locator('[data-source-control-path="fixture.txt"]') })
      .first()
    await expect(webPanel.locator('[data-source-control-path="fixture.txt"]')).toBeVisible()
    await webPanel.getByRole('button', { name: 'Stage All', exact: true }).click()
    await webPanel.getByPlaceholder('Message', { exact: true }).fill('Keep web draft')
    await backendToggle.click()
    const activePanel = overview.locator('[data-source-control-repository]')
    await activePanel.getByRole('button', { name: 'Stage All', exact: true }).click()
    await expect(activePanel.getByPlaceholder('Message', { exact: true })).toHaveValue('')
    await activePanel.getByPlaceholder('Message', { exact: true }).fill('Keep backend draft')
    await webToggle.click()
    await expect(webPanel.getByPlaceholder('Message', { exact: true })).toHaveValue(
      'Keep web draft'
    )
    await webPanel.getByPlaceholder('Message', { exact: true }).fill('')
    await expect(sidebar.locator('[aria-current="page"][data-worktree-id]')).toHaveAttribute(
      'data-worktree-id',
      /^folder:/
    )
    const chatButton = sidebar.getByRole('button', {
      name: 'New chat in Navigation project',
      exact: true
    })
    const before = await chatButton.boundingBox()
    await chatButton.hover()
    const after = await chatButton.boundingBox()
    expect(after?.x).toBe(before?.x)
    const header = sidebar.locator(`[data-project-group-header-id="${prepared.groupId}"]`)
    const headerBox = await header.boundingBox()
    expect(headerBox).toBeTruthy()
    expect(after).toBeTruthy()
    expect(headerBox!.x + headerBox!.width - (after!.x + after!.width)).toBeLessThanOrEqual(12)
    const repoHeader = sidebar
      .locator('[data-repo-header-id]')
      .filter({ has: page.getByRole('button', { name: 'Open repository apps/web', exact: true }) })
    const repoChat = repoHeader.getByRole('button', { name: 'New chat in web', exact: true })
    const repoBefore = await repoChat.boundingBox()
    await repoChat.hover()
    expect(await repoChat.boundingBox()).toEqual(repoBefore)
    const repoBox = await repoHeader.boundingBox()
    expect(repoBox!.x + repoBox!.width - (repoBefore!.x + repoBefore!.width)).toBeLessThanOrEqual(
      12
    )
    await webPanel.locator('[data-source-control-path="fixture.txt"]').click()
    await expect(sidebar.locator('[aria-current="page"][data-worktree-id]')).toHaveAttribute(
      'data-worktree-id',
      /apps\/web/
    )
    await expect(
      page.locator('[data-terminal-tab-id]').filter({ hasText: /^Terminal \d/ })
    ).toHaveCount(0)
    await expect(overview).toBeVisible()
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible()
    const repoId = await webPanel.getAttribute('data-source-control-repository')
    const controls = overview.locator(`[data-source-control-repository="${repoId}"]`)
    await controls.getByPlaceholder('Message', { exact: true }).fill('Navigation verified commit')
    await controls.getByRole('button', { name: 'Commit', exact: true }).click()
    await expect(controls.locator('[data-source-control-path="fixture.txt"]')).toHaveCount(0)
    await controls.getByText('Commits', { exact: true }).click()
    const commit = controls.getByText('Navigation verified commit', { exact: true })
    await expect(commit).toBeVisible()
    await commit.click()
    await expect(controls.getByText(/^Audit ·/)).toBeVisible()
    await expect(controls.getByTestId('git-history-commit-file')).toBeVisible()
    const resize = controls.getByRole('separator', { name: 'Resize commits', exact: true })
    const oldHeight = Number(await resize.getAttribute('aria-valuenow'))
    await resize.focus()
    await page.keyboard.press('ArrowUp')
    const resizedHeight = Number(await resize.getAttribute('aria-valuenow'))
    expect(resizedHeight).not.toBe(oldHeight)
    const historyScroll = controls
      .locator('.overflow-y-auto')
      .filter({ has: page.getByText('Navigation verified commit', { exact: true }) })
    await historyScroll.evaluate((node) => {
      node.scrollTop = 100
      node.dispatchEvent(new Event('scroll'))
    })
    const savedScroll = await historyScroll.evaluate((node) => node.scrollTop)
    expect(savedScroll).toBeGreaterThan(0)
    await backendToggle.click()
    await expect(overview.getByText('Navigation verified commit', { exact: true })).toHaveCount(0)
    await webToggle.click()
    await expect(controls.getByText(/^Audit ·/)).toBeAttached()
    await expect(resize).toHaveAttribute('aria-valuenow', String(resizedHeight))
    await expect.poll(() => historyScroll.evaluate((node) => node.scrollTop)).toBe(savedScroll)
    await historyScroll.evaluate((node) => {
      node.scrollTop = 0
      node.dispatchEvent(new Event('scroll'))
    })
    await controls.getByTestId('source-control-filter-toggle').click()
    await controls.getByTestId('source-control-filter-input').fill('fixture')
    await backendToggle.click()
    await expect(overview.getByTestId('source-control-filter-input')).toHaveCount(0)
    await webToggle.click()
    await expect(controls.getByTestId('source-control-filter-input')).toHaveValue('fixture')
    await controls.getByTestId('source-control-filter-input').fill('')
    await expect(controls.getByText('Loading graph...', { exact: true })).toHaveCount(0)
    await controls.getByRole('button', { name: 'Refresh commits', exact: true }).click()
    await expect(controls.getByText(/^Audit ·/)).toBeVisible()
    await expect(resize).toHaveAttribute('aria-valuenow', String(resizedHeight))
    await controls.getByTestId('git-history-commit-file').click()
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible()
    await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({ path: testInfo.outputPath('project-source-control-dark.png') })
    await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'light' }))
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.screenshot({ path: testInfo.outputPath('project-source-control-light.png') })
    await expect(
      page.getByText('Source Control is only available for Git repositories', { exact: true })
    ).toHaveCount(0)
    const groupHeader = sidebar.locator(`[data-project-group-header-id="${prepared.groupId}"]`)
    const tree = await sidebar.locator('[data-project-group-header-id]').evaluateAll((rows) =>
      rows.map((row) => ({
        name: row.textContent,
        padding: Number.parseFloat(getComputedStyle(row).paddingLeft)
      }))
    )
    const rootRow = tree.find((row) => row.name?.includes('Navigation project'))
    expect(rootRow).toBeTruthy()
    expect(tree.some((row) => row.name === 'apps')).toBe(false)
    await expect(groupHeader).toBeVisible()
    await host.click()
    await expect(groupHeader).toHaveCount(0)
    await session.close(app)
    app = undefined
    launched = await session.launch({ executablePath })
    app = launched.app
    await expect(launched.page.locator('[data-host-header-drag-id="local"]')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await launched.page.locator('[data-host-header-drag-id="local"]').click()
    await expect(
      launched.page.locator(`[data-project-group-header-id="${prepared.groupId}"]`)
    ).toBeVisible()
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } finally {
    await session.dispose(app)
    rmSync(root, { recursive: true, force: true })
  }
})
