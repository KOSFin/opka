import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, type Page } from '@stablyai/playwright-test'
import type { ProjectTaskWorkflow } from '../../../src/shared/project-task-workflow'

export async function verifyForkTaskReview(
  page: Page,
  root: string,
  workflow: ProjectTaskWorkflow | undefined,
  screenshotPath: string
) {
  expect(workflow?.attempts).toHaveLength(1)
  expect(workflow?.attempts[0]?.session?.reportPath).toBeTruthy()
  expect(workflow?.phase).toBe('review')
  expect(readFileSync(join(root, 'sum.mjs'), 'utf8')).not.toContain('return a - b')
  const checks = runProcessSync({
    program: process.execPath,
    args: ['--test', 'sum.test.mjs'],
    cwd: root,
    maxOutputBytes: 4096,
    timeoutMs: 10000
  })
  expect(checks.code).toBe(0)
  await page.evaluate(() => window.__store!.getState().setActiveView('tasks'))
  await page.getByRole('combobox', { name: 'Task project' }).click()
  await page.getByRole('option', { name: /Real Codex task smoke/ }).click()
  await page.getByRole('button', { name: /Исправить сложение/ }).click()
  await page.getByRole('button', { name: 'Reports & notes', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Task reports and notes' })).toContainText('sum')
  await page.screenshot({ path: screenshotPath })
}
