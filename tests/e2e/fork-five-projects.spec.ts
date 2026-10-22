import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { installProjectTaskProtocolAgent } from './helpers/project-task-protocol-agent'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import type { ProjectTaskEntry } from '../../src/shared/project-task-contract'
import type { ProjectTaskWorkflow } from '../../src/shared/project-task-workflow'
import type { ElectronApplication } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'Explicit background Electron required')
test.use({ trace: 'off', screenshot: 'off' })

test('five projects keep independent real PTY workers when the task view is closed', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240000)
  expect(testRepoPath).toBeTruthy()
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-five-pty-')))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const command = installProjectTaskProtocolAgent(bin)
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`
  })
  const client = new RuntimeClient(session.userDataDir, 45000, null, null)
  const projects: { task: ProjectTaskEntry; worktree: string; coordinator: string }[] = []
  const dispatches: string[] = []
  let app: ElectronApplication | undefined
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    const page = launched.page
    await page.evaluate(
      ({ command, shell }) =>
        window.__store!.getState().updateSettings({
          experimentalNativeChat: false,
          agentCmdOverrides: { codex: command },
          terminalWindowsShell: shell
        }),
      { command, shell: FAKE_AGENT_WINDOWS_SHELL }
    )
    for (let index = 0; index < 5; index++) {
      const directory = path.join(root, `project-${index}`)
      mkdirSync(directory)
      execFileSync('git', ['init', '-q'], { cwd: directory })
      execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: directory })
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
          'Synthetic'
        ],
        { cwd: directory }
      )
      const id = await attachRepoAndOpenTerminal(page, directory)
      await waitForSessionReady(page)
      await ensureTerminalVisible(page)
      await waitForActivePanePtyId(page)
      const pane = await waitForActivePaneHookDescriptor(page)
      const coordinator = (
        await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
          paneKey: pane.paneKey
        })
      ).result.terminal.handle
      await client.call('orchestration.runCreate', {
        objective: `Five-project protocol coordinator ${index}; not a real model`,
        from: coordinator
      })
      const worktree = `id:${id}`
      await client.call('projectTask.init', { worktree, expectedExecutionHostId: 'local' })
      const created = await client.call<ProjectTaskEntry>('projectTask.create', {
        worktree,
        expectedExecutionHostId: 'local',
        source: 'project',
        slug: 'implementation',
        content: projectTaskTemplate({
          id: `task-${randomUUID()}`,
          title: `Five-project ${index}`,
          goal: `Only PROJECT_SCOPE_${index}`,
          detailed: true
        })
      })
      projects.push({ task: created.result, worktree, coordinator })
    }
    await page.locator('[data-contextual-tour-target="sidebar-tasks"]').click()
    await page.getByRole('heading', { name: 'Project tasks', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Five-project \d/ })).toHaveCount(5)
    for (const entry of projects) {
      await page.getByRole('button', { name: new RegExp(`^${entry.task.title}`) }).click()
      await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
      await page
        .getByRole('dialog', { name: 'Approve current plan' })
        .getByRole('button', { name: 'Confirm', exact: true })
        .click()
      await page.getByRole('button', { name: 'Activity', exact: true }).click()
      await page
        .getByRole('textbox', { name: 'Coordinator terminal handle' })
        .fill(entry.coordinator)
      await page.getByRole('textbox', { name: 'Worker placement' }).fill(entry.worktree)
      await page.getByRole('textbox', { name: 'Agent ID', exact: true }).fill('codex')
      await page.getByRole('button', { name: 'Start managed worker', exact: true }).click()
      const start = page.getByRole('dialog', { name: 'Start approved task' })
      await start.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(start).toBeHidden({ timeout: 60000 })
      await expect(page.getByRole('button', { name: 'Inspect worker', exact: true })).toBeVisible()
      const workflow = (
        await client.call<ProjectTaskWorkflow>('projectTask.workflow', {
          worktree: entry.worktree,
          id: entry.task.id
        })
      ).result
      const dispatch = workflow.attempts[0]?.dispatchId
      if (!dispatch) {
        throw new Error('Managed attempt has no Dispatch')
      }
      dispatches.push(dispatch)
      await page
        .getByRole('dialog', { name: entry.task.title, exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click()
    }
    await page.getByRole('button', { name: 'External trackers', exact: true }).click()
    await page.getByRole('button', { name: 'Project tasks', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Five-project \d/ })).toHaveCount(5)
    for (const [index, entry] of projects.entries()) {
      await page.getByRole('button', { name: new RegExp(`^${entry.task.title}`) }).click()
      await page.getByRole('button', { name: 'Plan', exact: true }).click()
      await expect(page.getByText(`Only PROJECT_SCOPE_${index}`, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Activity', exact: true }).click()
      await page.getByRole('button', { name: 'Inspect worker', exact: true }).click()
      await expect(page.getByRole('textbox', { name: 'Worker inspection' })).toHaveValue(
        /"provider"/
      )
      await expect(page.getByRole('textbox', { name: 'Worker inspection' })).toHaveValue(
        /"status":\s*"live"/
      )
      await expect(page.getByRole('textbox', { name: 'Worker inspection' })).toHaveValue(
        /"exactWorker":\s*true/
      )
      await page.getByRole('button', { name: 'Stop worker', exact: true }).click()
      const stop = page.getByRole('dialog', { name: 'Stop this exact worker' })
      await stop.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(stop).toBeHidden({ timeout: 45000 })
      await expect(page.getByText('Recorded runtime events', { exact: true })).toBeVisible()
      await page
        .getByRole('dialog', { name: entry.task.title, exact: true })
        .getByRole('button', { name: 'Close', exact: true })
        .click()
    }
    await page.screenshot({ path: testInfo.outputPath('five-project-board.png') })
  } finally {
    for (const dispatch of dispatches) {
      await client.call('orchestration.workerStop', { dispatch }).catch(() => undefined)
    }
    await session.dispose(app)
    rmSync(root, { recursive: true, force: true })
  }
})
