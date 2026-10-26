import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { prepareForkProfileCli } from './helpers/fork-profile-cli'
import {
  FORK_TASK_TERMINAL_FIXTURE,
  FORK_TASK_FILTERED_CODEX_FIXTURE
} from './helpers/fork-task-terminal-fixture'
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

for (const managedLaunch of [true, false]) {
  for (const filteredCommands of [false, true]) {
    test(`${managedLaunch ? 'managed agent' : 'ordinary shell'} ${filteredCommands ? 'filtered Codex wrapper' : 'inherited env'} terminal CLI submits a visible report that survives a hidden restart without a model`, async ({
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
        const baselineApp =
          !managedLaunch && filteredCommands ? process.env.ORCA_FORK_BASELINE_APP : undefined
        let launched = await session.launch(
          baselineApp
            ? {
                executablePath: join(baselineApp, 'Contents', 'MacOS', 'Opka'),
                packaged: true
              }
            : options
        )
        app = launched.app
        let page = launched.page
        expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(
          Boolean(baselineApp || packagedApp)
        )
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
        await rpc(page, 'projectTask.approve', {
          ...task,
          worktree,
          expectedExecutionHostId: 'local'
        })
        if (baselineApp) {
          const priorTerminal = z.object({ terminal: z.object({ handle: z.string() }) }).parse(
            await rpc(page, 'terminal.create', {
              worktree,
              presentation: 'background',
              command: "printf 'OPKA_PRIOR_PTY_PRESERVED\\n'"
            })
          )
          await expect
            .poll(
              async () =>
                JSON.stringify(
                  await rpc(page, 'terminal.read', { terminal: priorTerminal.terminal.handle })
                ),
              { timeout: 15000 }
            )
            .toContain('OPKA_PRIOR_PTY_PRESERVED')
          await session.close(app)
          app = undefined
          launched = await session.launch(options)
          app = launched.app
          page = launched.page
          await expect
            .poll(
              async () => {
                const listed = z
                  .object({ terminals: z.array(z.object({ handle: z.string() })) })
                  .parse(await rpc(page, 'terminal.list', {}))
                return JSON.stringify(
                  await Promise.all(
                    listed.terminals.map((terminal) =>
                      rpc(page, 'terminal.read', { terminal: terminal.handle })
                    )
                  )
                )
              },
              {
                timeout: 15000
              }
            )
            .toContain('OPKA_PRIOR_PTY_PRESERVED')
        }
        const script = join(root, 'terminal-check.cjs')
        writeFileSync(script, FORK_TASK_TERMINAL_FIXTURE)
        const bin = join(root, 'bin')
        mkdirSync(bin)
        writeFileSync(
          join(bin, 'codex'),
          `#!/usr/bin/env node\n${FORK_TASK_FILTERED_CODEX_FIXTURE}`,
          { mode: 0o755 }
        )
        const fixturePath = [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter)
        const pauseOwner = !managedLaunch && filteredCommands
        const args = [
          script,
          cli,
          session.userDataDir,
          ...(pauseOwner ? ['pause'] : !managedLaunch ? ['release'] : [])
        ]
          .map(quotePosixShell)
          .join(' ')
        const command = filteredCommands
          ? `PATH=${quotePosixShell(fixturePath)} codex ${args}`
          : `${quotePosixShell(process.execPath)} ${args}`
        await rpc(page, 'terminal.create', {
          worktree,
          title: 'Synthetic lifecycle check (no model)',
          ...(managedLaunch
            ? {
                launchAgent: 'codex',
                launchConfig: {
                  agentCommand: filteredCommands ? 'codex' : process.execPath,
                  agentArgs: args,
                  agentEnv: {}
                }
              }
            : {}),
          presentation: 'background',
          env: { PATH: fixturePath },
          startupCommandDelivery: 'shell-ready',
          command
        })
        const receiptPath = join(root, 'receipt.json')
        if (pauseOwner) {
          await expect
            .poll(() => existsSync(join(root, 'claimed.json')), { timeout: 45000 })
            .toBe(true)
          const competitorArgs = [script, cli, session.userDataDir, 'compete']
            .map(quotePosixShell)
            .join(' ')
          await rpc(page, 'terminal.create', {
            worktree,
            title: 'Synthetic competing terminal (no model)',
            presentation: 'background',
            env: { PATH: fixturePath },
            startupCommandDelivery: 'shell-ready',
            command: `PATH=${quotePosixShell(fixturePath)} codex ${competitorArgs}`
          })
          const competitorPath = join(root, 'competitor.json')
          await expect.poll(() => existsSync(competitorPath), { timeout: 45000 }).toBe(true)
          expect(JSON.parse(readFileSync(competitorPath, 'utf8'))).toEqual({ denied: true })
          await session.close(app)
          app = undefined
          launched = await session.launch(options)
          app = launched.app
          page = launched.page
          await rpc(page, 'terminal.list', {})
          writeFileSync(join(root, 'continue.json'), '{}')
        }
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
  }
}
