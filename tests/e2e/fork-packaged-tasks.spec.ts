import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { prepareForkProfileCli } from './helpers/fork-profile-cli'
import { FORK_TASK_TERMINAL_FIXTURE } from './helpers/fork-task-terminal-fixture'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const packagedApp = process.env.ORCA_FORK_PACKAGED_APP
const executablePath = packagedApp
  ? join(packagedApp, 'Contents', 'MacOS', 'Opka')
  : process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(
  !executablePath || process.platform !== 'darwin',
  'Explicit isolated Mac executable required'
)
test.use({ trace: 'off', screenshot: 'off' })

async function rpc(page: Page, method: string, params: Record<string, unknown>) {
  const reply = await page.evaluate((request) => window.api.runtime.call(request), {
    method,
    params
  })
  if (!reply.ok) {
    throw new Error(`${method}: ${reply.error.message}`)
  }
  return reply.result
}

async function openReport(page: Page) {
  await page.getByText('Tasks', { exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Task project' }).click()
  await page.getByRole('option', { name: /Packaged task project/ }).click()
  await page.getByRole('button', { name: /Packaged task smoke/ }).click()
  await page.getByRole('button', { name: 'Reports & notes', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Task reports and notes' })).toContainText(
    'Terminal CLI lifecycle checked'
  )
}

test('own terminal CLI submits a visible report that survives a hidden restart without a model', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(120000)
  expect(testRepoPath).toBeTruthy()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opka-packaged-task-')))
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_ENVIRONMENT: '',
    ORCA_PAIRING_CODE: '',
    ORCA_REMOTE_PAIRING: '',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1'
  })
  let app: ElectronApplication | undefined
  try {
    if (!executablePath) {
      throw new Error('Explicit test executable missing')
    }
    const cli = packagedApp
      ? join(packagedApp, 'Contents', 'Resources', 'bin', 'orca')
      : await prepareForkProfileCli(session.userDataDir, executablePath)
    const options = { executablePath, packaged: Boolean(packagedApp) }
    let launched = await session.launch(options)
    app = launched.app
    const page = launched.page
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(Boolean(packagedApp))
    const worktree = await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'Packaged task project',
        parentPath: folderPath
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Packaged task project',
        folderPath
      })
      return `folder:${folder.id}`
    }, root)
    await rpc(page, 'projectTask.init', { worktree, expectedExecutionHostId: 'local' })
    const task = z.object({ id: z.string(), revision: z.string() }).parse(
      await rpc(page, 'projectTask.create', {
        worktree,
        expectedExecutionHostId: 'local',
        source: 'project',
        slug: 'smoke',
        content: projectTaskTemplate({
          id: 'task-00000000-0000-4000-8000-000000000006',
          title: 'Packaged task smoke'
        })
      })
    )
    await rpc(page, 'projectTask.approve', { ...task, worktree, expectedExecutionHostId: 'local' })
    const script = join(root, 'terminal-check.cjs')
    writeFileSync(script, FORK_TASK_TERMINAL_FIXTURE)
    await rpc(page, 'terminal.create', {
      worktree,
      title: 'Synthetic lifecycle check (no model)',
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: process.execPath,
        agentArgs: [script, cli, session.userDataDir].map(quotePosixShell).join(' '),
        agentEnv: {}
      },
      presentation: 'background',
      startupCommandDelivery: 'shell-ready',
      command: [process.execPath, script, cli, session.userDataDir].map(quotePosixShell).join(' ')
    })
    const receiptPath = join(root, 'receipt.json')
    await expect.poll(() => existsSync(receiptPath), { timeout: 45000 }).toBe(true)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    writeFileSync(testInfo.outputPath('terminal-receipt.json'), JSON.stringify(receipt))
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true, phase: 'review' })
    await openReport(page)
    await page.screenshot({ path: testInfo.outputPath('packaged-task-report.png') })
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Recorded runtime events' })).toBeVisible()
    await session.close(app)
    app = undefined
    launched = await session.launch(options)
    app = launched.app
    await openReport(launched.page)
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
