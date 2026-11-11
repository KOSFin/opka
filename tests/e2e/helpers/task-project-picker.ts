import { expect, type Page } from '@stablyai/playwright-test'

const allProjects = (page: Page) =>
  page.getByRole('menuitemcheckbox', { name: 'Select all projects', exact: true })

export async function selectTaskProject(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Task projects', exact: true }).click()
  const all = allProjects(page)
  if ((await all.getAttribute('aria-checked')) !== 'true') {
    await all.click()
  }
  await all.click()
  const project = page
    .getByRole('menuitemcheckbox', { name: /^Project:/ })
    .filter({ hasText: name })
  await expect(project).toHaveCount(1)
  await project.click()
  await page.keyboard.press('Escape')
}

export async function selectAllTaskProjects(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Task projects', exact: true }).click()
  const all = allProjects(page)
  if ((await all.getAttribute('aria-checked')) !== 'true') {
    await all.click()
  }
  await page.keyboard.press('Escape')
}
