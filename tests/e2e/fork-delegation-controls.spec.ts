import { expect, test } from './helpers/orca-app'
import { selectTaskProject } from './helpers/task-project-picker'

test.use({ trace: 'off', screenshot: 'off' })

test('hidden desktop reviews an exact synthetic policy and preserves manual fallback', async ({
  orcaPage: page,
  testRepoPath
}, testInfo) => {
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  const grantee = await page.evaluate(async (folderPath) => {
    const group = await window.api.projectGroups.create({
      name: 'Delegation audit',
      parentPath: folderPath
    })
    const folder = await window.api.folderWorkspaces.create({
      projectGroupId: group.id,
      name: 'Delegation audit',
      folderPath
    })
    const worktree = `folder:${folder.id}`
    const initialized = await window.api.runtime.call({
      method: 'projectTask.init',
      params: { worktree, expectedExecutionHostId: 'local' }
    })
    if (!initialized.ok) {
      throw new Error(initialized.error.message)
    }
    const created = await window.api.runtime.call({
      method: 'terminal.create',
      params: { worktree, title: 'Synthetic grantee' }
    })
    if (!created.ok) {
      throw new Error(created.error.message)
    }
    const value = created.result
    if (
      !value ||
      typeof value !== 'object' ||
      !('terminal' in value) ||
      !value.terminal ||
      typeof value.terminal !== 'object' ||
      !('handle' in value.terminal) ||
      typeof value.terminal.handle !== 'string'
    ) {
      throw new Error('Synthetic terminal did not return a handle')
    }
    await window.__store!.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
    window.__store!.getState().setActiveView('tasks')
    return value.terminal.handle
  }, testRepoPath)
  await expect(page.getByRole('heading', { name: 'Project tasks', exact: true })).toBeVisible()
  await selectTaskProject(page, /Delegation audit/)
  const settings = page.getByRole('button', { name: 'Board settings' })
  await settings.click()
  await page.getByRole('button', { name: 'Task approval', exact: true }).click()
  const controls = page.getByRole('region', { name: 'Project task approval mode' })
  await expect(controls.getByText(/Manual · generation 0/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('delegation-manual-light.png') })
  await controls.getByLabel('Verified grantee session or terminal').fill(grantee)
  await controls.getByRole('button', { name: 'Review delegation…' }).click()
  const review = page.getByRole('dialog', { name: 'Confirm scoped delegation' })
  await expect(review).toBeVisible()
  await expect(review.getByText(`Root: ${testRepoPath}`)).toBeVisible()
  await expect(review.getByText(/Grantee:/)).toContainText(grantee)
  await expect(review.getByText('Actions: Approve plans')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('delegation-review-light.png') })
  await page.keyboard.press('Escape')
  await expect(review).toHaveCount(0)
  await controls.getByRole('button', { name: 'Review delegation…' }).click()
  await review.getByRole('button', { name: 'Confirm on this host' }).click()
  await expect(controls.getByText(/Delegated policy · generation 1/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('delegation-delegated-light.png') })
  await controls.getByRole('button', { name: 'Revoke / return manual…' }).click()
  const manual = page.getByRole('dialog', { name: 'Return to manual approval' })
  await expect(manual).toBeVisible()
  await expect(manual.getByText(`Root: ${testRepoPath}`)).toBeVisible()
  await manual.getByRole('button', { name: 'Confirm on this host' }).click()
  await expect(controls.getByText(/Manual · generation 2/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('delegation-revoked-light.png') })
})
