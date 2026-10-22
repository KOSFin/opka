export async function installTaskTimingProbe(
  app,
  channels = ['runtimeEnvironments:call', 'runtime:call']
) {
  await app.evaluate(async ({ ipcMain }, channels) => {
    const entries = []
    globalThis.__forkTaskRpcTimings = entries
    for (const channel of channels) {
      const deadline = Date.now() + 5000
      while (!ipcMain._invokeHandlers?.has(channel) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const handler = ipcMain._invokeHandlers?.get(channel)
      if (!handler) {
        throw new Error(`QA timing handler missing: ${channel}`)
      }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, args) => {
        const start = Date.now()
        const entry = {
          channel,
          method: args?.method,
          start,
          ms: null,
          worktreePath: args?.worktreePath
        }
        if (entries.length < 1000) {
          entries.push(entry)
        }
        try {
          const result = await handler(event, args)
          entry.outcome = result?.summary?.status ?? result?.result?.summary?.status
          return result
        } finally {
          entry.ms = Date.now() - start
        }
      })
    }
  }, channels)
}

export async function readTaskTimingProbe(app) {
  return app.evaluate(() => globalThis.__forkTaskRpcTimings)
}

async function measureGitSwitch(page, expect, app, overview) {
  const web = overview.getByRole('button', { name: 'Source Control for web', exact: true })
  const backend = overview.getByRole('button', { name: 'Source Control for backend', exact: true })
  const reads = async () =>
    (await readTaskTimingProbe(app)).filter(
      (entry) =>
        ['repos:getBaseRefDefault', 'git:branchCompare'].includes(entry.channel) ||
        ['git.branchCompare', 'repo.baseRefDefault'].includes(entry.method ?? '')
    )
  for (const button of [backend, web]) {
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(overview.getByText('Comparing against', { exact: false })).toHaveCount(0)
    await expect
      .poll(async () => (await reads()).filter((entry) => entry.ms === null).length)
      .toBe(0)
  }
  const before = (await reads()).length
  const comparisons = (await reads()).filter(
    (entry) => entry.channel === 'git:branchCompare' || entry.method === 'git.branchCompare'
  )
  expect(comparisons.length).toBeGreaterThan(0)
  expect(comparisons.every((entry) => entry.outcome === 'ready')).toBe(true)
  const start = Date.now()
  for (const button of [backend, web]) {
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(overview.getByText('Comparing against', { exact: false })).toHaveCount(0)
  }
  const result = {
    ms: Date.now() - start,
    extraBaseAndCompareReads: (await reads()).length - before
  }
  expect(result.extraBaseAndCompareReads).toBe(0)
  return result
}

export async function checkAcceptanceNavigation(page, expect, { workspace, remote, app }) {
  const gitSwitch = {}
  const sidebar = page.locator('[data-worktree-sidebar]')
  const localHost = sidebar.locator('[data-host-header-drag-id="local"]')
  await expect(localHost).toBeVisible()
  const remoteHost = remote
    ? sidebar.locator(`[data-host-header-drag-id="runtime:${remote.environmentId}"]`)
    : null
  if (remoteHost) {
    await expect(remoteHost).toBeVisible()
  }
  await expect(localHost.locator('.lucide-server, .lucide-server-off')).toHaveCount(0)
  if ((await localHost.getAttribute('aria-expanded')) === 'false') {
    await localHost.click()
  }
  const local = await page.evaluate(async (root) => {
    const groups = await window.api.projectGroups.list()
    const group = groups.find((entry) => entry.parentPath === root && !entry.parentGroupId)
    if (!group) {
      throw new Error('Acceptance project root missing')
    }
    const child = groups.find((entry) => entry.parentGroupId === group.id && entry.name === 'apps')
    if (!child) {
      throw new Error('Acceptance project child missing')
    }
    return { id: group.id, name: group.name, childId: child.id }
  }, workspace)
  const rootHeader = sidebar.locator(`[data-project-group-header-id="${local.id}"]`)
  if ((await rootHeader.getAttribute('aria-expanded')) === 'false') {
    await rootHeader.locator('[data-repo-header-collapse-affordance]').click()
  }
  const childHeader = sidebar
    .locator('[data-repo-header-id]')
    .filter({ has: page.getByRole('button', { name: 'Open repository apps/web', exact: true }) })
    .first()
  const rootIndent = await rootHeader.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).paddingLeft)
  )
  const childIndent = await childHeader.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).paddingLeft)
  )
  if (childIndent <= rootIndent) {
    throw new Error('Acceptance repository must be inside its project')
  }
  await page.getByRole('button', { name: `Open project ${local.name}`, exact: true }).click()
  const localProjectName = page.getByRole('button', {
    name: `Open project ${local.name}`,
    exact: true
  })
  if ((await localProjectName.evaluate((node) => getComputedStyle(node).cursor)) !== 'pointer') {
    throw new Error('Project name must use the open-action cursor')
  }
  await page.getByRole('button', { name: `New chat in ${local.name}`, exact: true }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menu').getByRole('menuitem')).not.toHaveCount(0)
  await page.keyboard.press('Escape')
  const sourceControl = page.getByRole('button', { name: /^Source Control(?: \(.+\))?$/ })
  const sourceControlActionable = await sourceControl.click({ trial: true, timeout: 1000 }).then(
    () => true,
    () => false
  )
  if (!sourceControlActionable) {
    await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click()
  }
  await sourceControl.click()
  const overview = page.getByRole('region', { name: 'Project repositories' })
  await expect(overview.getByRole('button', { name: /^Source Control for / })).toHaveCount(3)
  const localRepo = overview.getByRole('button', { name: 'Source Control for web', exact: true })
  await localRepo.click()
  await expect(localRepo).toHaveAttribute('aria-pressed', 'true')
  await expect(overview.locator('[data-source-control-repository]')).toHaveCount(1)
  await expect(overview.locator('[data-source-control-repository]')).toBeVisible()
  if (app) {
    gitSwitch.local = await measureGitSwitch(page, expect, app, overview)
  }
  await expect(sidebar.locator('[aria-current="page"][data-worktree-id]')).toHaveAttribute(
    'data-worktree-id',
    /^folder:/
  )
  await localHost.click()
  await expect(rootHeader).toHaveCount(0)
  if (remoteHost) {
    await expect(remoteHost).toBeVisible()
  }
  await localHost.click()
  await expect(rootHeader).toBeVisible()
  if (remoteHost) {
    if ((await remoteHost.getAttribute('aria-expanded')) === 'false') {
      await remoteHost.click()
    }
    await page
      .getByRole('button', { name: 'Open project REMOTE — Fork acceptance', exact: true })
      .click()
    await sourceControl.click()
    await expect(overview.getByRole('button', { name: /^Source Control for / })).toHaveCount(3)
    const remoteRepo = overview.getByRole('button', { name: 'Source Control for web', exact: true })
    await remoteRepo.click()
    await expect(remoteRepo).toHaveAttribute('aria-pressed', 'true')
    await expect(overview.locator('[data-source-control-repository]')).toHaveCount(1)
    await expect(overview.locator('[data-source-control-repository]')).toBeVisible()
    if (app) {
      gitSwitch.remote = await measureGitSwitch(page, expect, app, overview)
    }
    await expect(
      sidebar.locator('[aria-current="page"][data-worktree-host-identity]')
    ).toHaveAttribute(
      'data-worktree-host-identity',
      new RegExp(`^runtime:${remote.environmentId}\\|`)
    )
  }
  // Return to the accepted task board instead of leaving a diagnostic screen selected.
  const returnStarted = Date.now()
  await page.locator('[data-contextual-tour-target="sidebar-tasks"]').click()
  await expect(page.getByRole('button', { name: /Проверить связку backend и web/ })).toHaveCount(
    remote ? 2 : 1
  )
  const warmBoardReturnMs = Date.now() - returnStarted
  await page.getByRole('button', { name: 'Open beside chat', exact: true }).click()
  const floating = page.locator('[data-floating-terminal-panel]')
  await expect(floating).toBeVisible()
  await floating.getByRole('button', { name: 'Workspace', exact: true }).click()
  await floating.getByRole('button', { name: 'Open project tasks', exact: true }).click()
  await expect(floating.getByTestId('project-task-card')).toHaveCount(remote ? 6 : 3)
  await floating.getByTestId('project-task-card').first().click()
  await expect(floating.getByRole('region', { name: 'Project task detail' })).toBeVisible()
  await floating.getByRole('button', { name: 'Back to board', exact: true }).click()
  await floating.getByRole('button', { name: 'Minimize floating workspace', exact: true }).click()
  await expect(floating).toBeHidden()
  await expect(floating.locator('[data-floating-project-tasks]')).toHaveAttribute('inert', '')
  await page.locator('[data-contextual-tour-target="sidebar-tasks"]').click()
  return {
    gitSwitch,
    warmBoardReturnMs,
    hostSections: true,
    nestedProjects: true,
    wholeProjectOpened: true,
    explicitChatLauncherOpened: true,
    repositoryGitOpened: true,
    oneActiveGitPanel: true,
    tasksBesideWorkspace: true,
    collapsePreservedOtherHost: true,
    remoteProjectGitOpened: Boolean(remoteHost)
  }
}
