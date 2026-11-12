import { writeFile } from 'node:fs/promises'
import { expect, test } from './helpers/orca-app'
import { selectTaskProject } from './helpers/task-project-picker'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' }, trace: 'off', screenshot: 'off' })

async function capture(page: Parameters<typeof selectTaskProject>[0], path: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const result = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false
    })
    await writeFile(path, Buffer.from(result.data, 'base64'))
  } finally {
    await cdp.detach()
  }
}

test('hidden desktop allows project agents until explicit revocation', async ({
  orcaPage: page,
  testRepoPath
}, testInfo) => {
  await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await page.evaluate(async (folderPath) => {
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
    await window.__store!.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
    window.__store!.getState().setActiveView('tasks')
  }, testRepoPath)
  await expect(page.getByRole('heading', { name: 'Project tasks', exact: true })).toBeVisible()
  await selectTaskProject(page, /Delegation audit/)
  const settings = page.getByRole('button', { name: 'Board settings' })
  await settings.click()
  await page.getByRole('button', { name: 'Task approval', exact: true }).click()
  const controls = page.getByRole('region', { name: 'Project task approval mode' })
  await expect(controls.getByText(/Manual · generation 0/)).toBeVisible()
  await capture(page, testInfo.outputPath('delegation-manual-light.png'))
  await controls.getByRole('button', { name: 'Allow agents…' }).click()
  const review = page.getByRole('dialog', { name: 'Allow project agents' })
  await expect(review).toBeVisible()
  await expect(review.getByText(`Root: ${testRepoPath}`)).toBeVisible()
  await expect(review.getByText(/Agents: verified agent sessions and terminals/)).toBeVisible()
  await expect(review.getByText(/Duration: Until revoked/)).toBeVisible()
  await capture(page, testInfo.outputPath('delegation-review-light.png'))
  await page.keyboard.press('Escape')
  await expect(review).toHaveCount(0)
  await controls.getByRole('button', { name: 'Allow agents…' }).click()
  await review.getByRole('button', { name: 'Confirm on this host' }).click()
  await expect(controls.getByText(/Agents allowed · generation 1/)).toBeVisible()
  await expect(controls.getByText(/until revoked/)).toBeVisible()
  await controls.getByRole('button', { name: 'Refresh policy' }).click()
  await expect(controls.getByText(/Agents allowed · generation 1/)).toBeVisible()
  await capture(page, testInfo.outputPath('delegation-delegated-light.png'))
  await controls.getByRole('button', { name: 'Manual approval…' }).click()
  const manual = page.getByRole('dialog', { name: 'Return to manual approval' })
  await expect(manual).toBeVisible()
  await expect(manual.getByText(`Root: ${testRepoPath}`)).toBeVisible()
  await manual.getByRole('button', { name: 'Confirm on this host' }).click()
  await expect(controls.getByText(/Manual · generation 2/)).toBeVisible()
  await capture(page, testInfo.outputPath('delegation-revoked-light.png'))
})
