import { expect, type Page } from '@stablyai/playwright-test'

export async function closeRestoredProjectTaskDetail(
  page: Page,
  title: string,
  project: string
): Promise<void> {
  const detail = page.getByRole('dialog', { name: title, exact: true })
  await expect(detail).toBeVisible()
  await expect(detail).toContainText(`${project} · This computer`)
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(detail).toBeHidden()
}
