import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

export async function captureAcceptanceSidebar(page, area, remote) {
  const sidebar = page.locator('[data-worktree-sidebar]')
  const snapshots = []
  const theme = await page.evaluate(async () => (await window.api.settings.get()).theme)
  await page.evaluate(() => window.api.settings.set({ theme: 'dark' }))
  await page.reload()
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
  await page
    .getByRole('button', { name: /Проверить связку backend и web/ })
    .first()
    .waitFor()
  if (remote) {
    await page
      .getByRole('button', { name: /Проверить связку backend и web/ })
      .filter({ hasText: 'REMOTE — Fork acceptance' })
      .waitFor()
  }
  const capture = async (state) => {
    await page.waitForTimeout(250)
    const rows = await sidebar.locator('[data-worktree-virtual-row]').evaluateAll((elements) =>
      elements.map((node) => {
        const rect = node.getBoundingClientRect()
        return {
          key: node.getAttribute('data-worktree-virtual-row-key'),
          top: rect.top,
          bottom: rect.bottom,
          position: getComputedStyle(node).position,
          label: node.textContent?.slice(0, 100),
          groups: [...node.querySelectorAll('[data-project-group-header-id]')].map((entry) =>
            entry.getAttribute('data-project-group-header-id')
          )
        }
      })
    )
    rows.sort((a, b) => a.top - b.top)
    snapshots.push({ state, rows })
    writeFileSync(path.join(area, 'sidebar-geometry.json'), JSON.stringify(snapshots, null, 2), {
      mode: 0o600
    })
    await page.screenshot({ path: path.join(area, `sidebar-${state}.png`) })
    assert.equal(
      new Set(rows.map((row) => row.key)).size,
      rows.length,
      `${state}: duplicate row keys`
    )
    for (let index = 1; index < rows.length; index++) {
      assert.ok(
        rows[index].top >= rows[index - 1].bottom - 1,
        `${state}: overlapping ${rows[index - 1].label} / ${rows[index].label}`
      )
    }
  }
  await capture('initial')
  const hosts = sidebar.locator('[data-host-header-drag-id]')
  const initial = await hosts.evaluateAll((elements) =>
    elements.map((node) => ({
      id: node.getAttribute('data-host-header-drag-id'),
      expanded: node.getAttribute('aria-expanded')
    }))
  )
  for (const host of initial) {
    const row = sidebar.locator(`[data-host-header-drag-id="${host.id}"]`)
    if ((await row.getAttribute('aria-expanded')) === 'true') {
      await row.locator('svg.lucide-chevron-down').click()
    }
    await capture(host.id === 'local' ? 'local-collapsed' : 'all-collapsed')
  }
  assert.equal(
    await sidebar
      .locator('[data-project-group-header-id], [data-repo-header-id], [data-worktree-id]')
      .count(),
    0,
    'Collapsed hosts retained project rows'
  )
  for (const host of initial.toReversed()) {
    const row = sidebar.locator(`[data-host-header-drag-id="${host.id}"]`)
    if ((await row.getAttribute('aria-expanded')) !== 'true') {
      await row.click()
    }
  }
  const project = page.getByRole('button', {
    name: 'Collapse LOCAL — Fork acceptance',
    exact: true
  })
  await project.locator('svg').click()
  await page.getByRole('button', { name: 'Expand LOCAL — Fork acceptance', exact: true }).waitFor()
  await capture('project-collapsed')
  await page.getByRole('button', { name: 'Expand LOCAL — Fork acceptance', exact: true }).click()
  await sidebar.evaluate((node) => {
    node.scrollTop = 0
  })
  await capture('expanded')
  await sidebar.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await capture('scrolled')
  await sidebar.evaluate((node) => {
    node.scrollTop = 0
  })
  for (const host of initial) {
    const row = sidebar.locator(`[data-host-header-drag-id="${host.id}"]`)
    if ((await row.getAttribute('aria-expanded')) !== host.expanded) {
      await row.click()
    }
  }
  await page.evaluate((theme) => window.api.settings.set({ theme }), theme)
  const catalog = await page.evaluate(async (environmentId) => {
    const select = (groups) =>
      groups.map(
        ({ id, name, parentPath, parentGroupId, createdFrom, executionHostId, connectionId }) => ({
          id,
          name,
          parentPath,
          parentGroupId,
          createdFrom,
          executionHostId,
          connectionId
        })
      )
    const local = select(await window.api.projectGroups.list())
    const response = environmentId
      ? await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'projectGroup.list',
          params: {}
        })
      : null
    return { local, remote: response?.ok ? select(response.result.groups) : [] }
  }, remote?.environmentId)
  writeFileSync(
    path.join(area, 'sidebar-diagnostic.json'),
    JSON.stringify({ snapshots, catalog }, null, 2),
    { mode: 0o600 }
  )
  return {
    noOverlap: true,
    captured: snapshots.map(({ state, rows }) => ({ state, rows: rows.length }))
  }
}
