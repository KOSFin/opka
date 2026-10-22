import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { installProjectTaskProtocolAgent } from './helpers/project-task-protocol-agent'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import type { ProjectTaskEntry } from '../../src/shared/project-task-contract'
import type { ProjectTaskWorkflow } from '../../src/shared/project-task-workflow'
import type { ElectronApplication } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
test.skip(!executablePath, 'An explicitly prepared background Electron bundle is required')
test.use({ trace: 'off', screenshot: 'off' })

test('a real managed PTY attempt survives the closed task view and cannot claim its own approval', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180000)
  const cliDirectory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'orca-project-task-protocol-'))
  )
  const command = installProjectTaskProtocolAgent(cliDirectory)
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    PATH: `${cliDirectory}${path.delimiter}${process.env.PATH ?? ''}`
  })
  let app: ElectronApplication | undefined
  let dispatchId: string | undefined
  const client = new RuntimeClient(session.userDataDir, 45000, null, null)
  try {
    const launched = await session.launch({ executablePath })
    app = launched.app
    const page = launched.page
    const worktreeId = await attachRepoAndOpenTerminal(page, testRepoPath)
    await waitForSessionReady(page)
    await page.evaluate(
      async ({ agentCommand, shell }) => {
        await window.__store!.getState().updateSettings({
          experimentalNativeChat: false,
          agentCmdOverrides: { codex: agentCommand },
          terminalWindowsShell: shell
        })
      },
      { agentCommand: command, shell: FAKE_AGENT_WINDOWS_SHELL }
    )
    await ensureTerminalVisible(page)
    await waitForActivePanePtyId(page)
    const pane = await waitForActivePaneHookDescriptor(page)
    const coordinator = await client.call<{ terminal: { handle: string } }>(
      'terminal.resolvePane',
      { paneKey: pane.paneKey }
    )
    await client.call('orchestration.runCreate', {
      objective: 'Project task protocol fixture; not a real LLM',
      from: coordinator.result.terminal.handle
    })
    const worktree = `id:${worktreeId}`
    await client.call('projectTask.init', { worktree, expectedExecutionHostId: 'local' })
    const created = await client.call<ProjectTaskEntry>('projectTask.create', {
      worktree,
      expectedExecutionHostId: 'local',
      source: 'project',
      slug: 'protocol',
      content: projectTaskTemplate({
        id: 'task-22222222-2222-4222-8222-222222222222',
        title: 'Protocol worker fixture'
      })
    })
    const task = created.result
    await expect(
      client.call('projectTask.approve', {
        worktree,
        id: task.id,
        revision: task.revision,
        expectedExecutionHostId: 'local'
      })
    ).rejects.toThrow(/confirmation/)
    await expect(
      client.call('projectTask.move', {
        worktree,
        id: task.id,
        revision: task.revision,
        expectedExecutionHostId: 'local',
        phase: 'done',
        reason: 'Agent cannot accept itself'
      })
    ).rejects.toThrow(/confirmation/)
    await page.evaluate(() => window.__store!.getState().setActiveView('tasks'))
    await expect(page.getByRole('heading', { name: 'Project tasks', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('button', { name: /Protocol worker fixture.*Plan to refine/ }).click()
    await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Approve current plan' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await page
      .getByRole('textbox', { name: 'Coordinator terminal handle' })
      .fill(coordinator.result.terminal.handle)
    await page.getByRole('textbox', { name: 'Worker placement' }).fill(worktree)
    await page.getByRole('textbox', { name: 'Agent ID', exact: true }).fill('codex')
    await page.getByRole('button', { name: 'Start managed worker', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Start approved task' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: 'Start approved task' })).toBeHidden({
      timeout: 60000
    })
    await expect(page.getByRole('button', { name: 'Inspect worker', exact: true })).toBeVisible()
    const workflow = (
      await client.call<ProjectTaskWorkflow>('projectTask.workflow', { worktree, id: task.id })
    ).result
    expect(workflow.attempts).toHaveLength(1)
    expect(workflow.attempts[0].workerState).toBe('ready')
    await expect(
      client.call('orchestration.workerStart', {
        task: workflow.attempts[0].nativeTaskId,
        from: coordinator.result.terminal.handle,
        worktree,
        agent: 'codex',
        projectTaskAdmission: {
          nativeTaskId: workflow.attempts[0].nativeTaskId,
          attemptId: workflow.attempts[0].id
        }
      })
    ).rejects.toThrow(/project-task start/)
    dispatchId = workflow.attempts[0].dispatchId ?? undefined
    if (!dispatchId) {
      throw new Error('Native managed Dispatch was not created')
    }
    await page.getByRole('button', { name: 'Inspect worker', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Worker inspection' })).toHaveValue(/"provider"/)
    await page
      .getByRole('dialog', { name: 'Protocol worker fixture', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    await page.getByRole('button', { name: 'External trackers', exact: true }).click()
    await page.getByRole('button', { name: 'Project tasks', exact: true }).click()
    await page.getByRole('button', { name: /Protocol worker fixture/ }).click()
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Inspect worker', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop worker', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Stop this exact worker' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: 'Stop this exact worker' })).toBeHidden({
      timeout: 45000
    })
    await expect(page.getByText('Recorded runtime events', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('managed-attempt.png') })
  } finally {
    if (dispatchId) {
      await client.call('orchestration.workerStop', { dispatch: dispatchId }).catch(() => undefined)
    }
    await session.dispose(app)
    rmSync(cliDirectory, { recursive: true, force: true })
  }
})
