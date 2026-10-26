import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { prepareForkProfileNodeCli } from './helpers/fork-profile-cli'
import { prepareForkCodexReadBoundary } from './helpers/fork-codex-read-boundary'
import { probeForkCodexStartup } from './helpers/fork-codex-startup'
import { startForkCodexScriptedTaskProvider } from './helpers/fork-codex-scripted-task-provider'
import { FORK_TASK_TERMINAL_FIXTURE } from './helpers/fork-task-terminal-fixture'
import { verifyForkTaskReview } from './helpers/fork-task-review'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { ProjectTaskWorkflow } from '../../src/shared/project-task-workflow'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
const scripted = process.env.ORCA_CODEX_TERMINAL_SCRIPTED === '1'
test.skip(
  (!scripted && process.env.ORCA_REAL_CODEX_TERMINAL_TASK_SMOKE !== '1') ||
    !executablePath ||
    process.platform !== 'darwin',
  'Explicit one-turn opt-in and isolated Mac Electron required'
)
test.use({ trace: 'off', screenshot: 'off' })

async function rpc(page: Page, method: string, params: Record<string, unknown>): Promise<unknown> {
  const reply = await page.evaluate((request) => window.api.runtime.call(request), {
    method,
    params
  })
  if (!reply.ok) {
    throw new Error(`${method}: ${reply.error.message}`)
  }
  return reply.result
}

test(`${scripted ? 'scripted local binary contract' : 'one real Codex exec'} takes a card from an ordinary filtered terminal and submits review`, async ({
  testRepoPath
}, info) => {
  test.setTimeout(240000)
  expect(testRepoPath).toBeTruthy()
  const source = process.env.ORCA_REAL_CODEX_AUTH_FILE
  const codex = process.env.ORCA_REAL_CODEX_BINARY
  if (
    (!scripted && (!source || !lstatSync(source).isFile())) ||
    !codex ||
    !existsSync(codex) ||
    !executablePath
  ) {
    throw new Error(
      'Explicit existing binary/login and isolated executable required; credentials are never printed'
    )
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opka-real-terminal-task-')))
  const deniedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'opka-denied-write-')))
  const session = createRestartSession(info, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    ORCA_ENVIRONMENT: '',
    ORCA_PAIRING_CODE: '',
    ORCA_REMOTE_PAIRING: ''
  })
  let app: ElectronApplication | undefined
  let turnSubmitted = false
  let workflow: ProjectTaskWorkflow | undefined
  let provider: Awaited<ReturnType<typeof startForkCodexScriptedTaskProvider>> | undefined
  try {
    const cli = await prepareForkProfileNodeCli(session.userDataDir)
    const home = join(session.userDataDir, 'home')
    const codexHome = join(home, '.codex')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    if (!scripted && source) {
      copyFileSync(source, join(codexHome, 'auth.json'))
      chmodSync(join(codexHome, 'auth.json'), 0o600)
    }
    if (scripted) {
      const script = join(root, 'task-transport.cjs')
      writeFileSync(script, FORK_TASK_TERMINAL_FIXTURE)
      provider = await startForkCodexScriptedTaskProvider(
        `printf 'export function add(a, b) { return a + b }\\n' > sum.mjs; node --test sum.test.mjs && node ${quotePosixShell(script)} ${quotePosixShell(cli)} ${quotePosixShell(session.userDataDir)} run 'Исправить сложение'`
      )
    }
    writeFileSync(
      join(codexHome, 'config.toml'),
      `${provider?.selection ?? ''}model_reasoning_effort="low"\nweb_search="disabled"\n[features]\nmulti_agent=false\n[shell_environment_policy]\ninherit="core"\n${provider?.config ?? ''}`
    )
    const bin = join(session.userDataDir, 'probe-bin')
    mkdirSync(bin)
    const ownedTemp = join(session.userDataDir, 'model-temp')
    mkdirSync(ownedTemp)
    const { profile, wrapper } = prepareForkCodexReadBoundary(bin, codex, [
      root,
      session.userDataDir
    ])
    const probeEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      TMPDIR: ownedTemp,
      ORCA_USER_DATA_PATH: session.userDataDir,
      ORCA_ENVIRONMENT: '',
      ORCA_PAIRING_CODE: '',
      ORCA_REMOTE_PAIRING: ''
    }
    const denied = runProcessSync({
      program: '/usr/bin/sandbox-exec',
      args: ['-f', profile, '/bin/ls', homedir()],
      cwd: root,
      maxOutputBytes: 1024,
      timeoutMs: 5000
    })
    expect(denied.code).not.toBe(0)
    expect(denied.stdout).toBe('')
    const help = runProcessSync({
      program: wrapper,
      args: ['exec', '--help'],
      cwd: root,
      env: probeEnv,
      maxOutputBytes: 16384,
      timeoutMs: 10000
    })
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('--skip-git-repo-check')
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# Synthetic task test\nWork only in this folder. No web/network tools, GitHub, SSH, other projects, credential inspection, extra agents or installs. Use the project task workflow and apply_patch.\n'
    )
    writeFileSync(join(root, 'sum.mjs'), 'export function add(a, b) { return a - b }\n')
    writeFileSync(
      join(root, 'sum.test.mjs'),
      "import {test} from 'node:test'\nimport {strict as assert} from 'node:assert'\nimport {add} from './sum.mjs'\ntest('adds positive values',()=>assert.equal(add(2,3),5))\ntest('adds negative values',()=>assert.equal(add(-4,1),-3))\n"
    )
    const fixturePath = [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter)
    let launched = await session.launch({ executablePath, extraEnv: { PATH: fixturePath } })
    app = launched.app
    let page = launched.page
    const worktree = await page.evaluate(async (folderPath) => {
      const group = await window.api.projectGroups.create({
        name: 'Real Codex task smoke',
        parentPath: folderPath
      })
      const folder = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'Real Codex task smoke',
        folderPath
      })
      await window.__store!.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      return `folder:${folder.id}`
    }, root)
    await rpc(page, 'projectTask.init', { worktree, expectedExecutionHostId: 'local' })
    const task = z.object({ id: z.string(), revision: z.string() }).parse(
      await rpc(page, 'projectTask.create', {
        worktree,
        expectedExecutionHostId: 'local',
        source: 'project',
        slug: 'addition',
        content: projectTaskTemplate({
          id: `task-${randomUUID()}`,
          title: 'Исправить сложение',
          goal: 'Исправить add в sum.mjs, тесты не менять. Выполнить node --test sum.test.mjs, сохранить checkpoint и фактический отчёт для Review.'
        })
      })
    )
    await rpc(page, 'projectTask.approve', { ...task, worktree, expectedExecutionHostId: 'local' })
    const board = runProcessSync({
      program: '/usr/bin/sandbox-exec',
      args: ['-f', profile, cli, 'project-task', 'board', '--json'],
      cwd: root,
      env: probeEnv,
      maxOutputBytes: 16384,
      timeoutMs: 10000
    })
    expect(board.code).toBe(0)
    expect(board.stdout).toContain('Исправить сложение')
    await probeForkCodexStartup(wrapper, root, probeEnv, 'opka-tasks')
    const deniedWrite = runProcessSync({
      program: '/usr/bin/sandbox-exec',
      args: [
        '-f',
        profile,
        '/bin/sh',
        '-c',
        `printf test > ${quotePosixShell(join(deniedRoot, 'must-not-exist'))}`
      ],
      cwd: root,
      env: probeEnv,
      maxOutputBytes: 1024,
      timeoutMs: 5000
    })
    expect(deniedWrite.code).not.toBe(0)
    expect(existsSync(join(deniedRoot, 'must-not-exist'))).toBe(false)
    if (process.env.ORCA_REAL_CODEX_PREFLIGHT_ONLY === '1') {
      console.info('terminal-task-smoke: preflight passed; no model prompt submitted')
      return
    }
    const prompt =
      'Выполни карточку «Исправить сложение» в текущем проекте. Найди её через проектный навык, возьми текущей сессией, исправь код, выполни тесты, сохрани checkpoint и отчёт, отправь на Review. Не принимай результат сам. Не читай другие проекты, аккаунты или секреты, не используй сеть и дополнительных агентов.'
    // Tool calls inherit the verified outer Seatbelt; macOS refuses a second sandbox_apply.
    const command = `PATH=${quotePosixShell(fixturePath)} CODEX_HOME=${quotePosixShell(codexHome)} TMPDIR=${quotePosixShell(ownedTemp)} codex exec --json --skip-git-repo-check --sandbox danger-full-access -c 'approval_policy="never"' ${quotePosixShell(prompt)} > model-output.jsonl 2> model-stderr.log; printf '%s' "$?" > model-exit.txt`
    console.info(
      scripted
        ? 'terminal-task-smoke: local scripted responses, no account/model'
        : 'terminal-task-smoke: submitting the single approved model prompt through ordinary PTY'
    )
    turnSubmitted = !scripted
    await rpc(page, 'terminal.create', {
      worktree,
      presentation: 'background',
      env: { PATH: fixturePath, CODEX_HOME: codexHome, TMPDIR: ownedTemp },
      startupCommandDelivery: 'shell-ready',
      command
    })
    await expect
      .poll(() => existsSync(join(root, 'model-exit.txt')), { timeout: 180000, intervals: [1000] })
      .toBe(true)
    expect(readFileSync(join(root, 'model-exit.txt'), 'utf8')).toBe('0')
    if (scripted) {
      const receipt = existsSync(join(root, 'receipt.json'))
        ? readFileSync(join(root, 'receipt.json'), 'utf8')
        : 'No tool receipt'
      expect(receipt, JSON.stringify(provider?.receipt())).toContain('"ok":true')
    }
    const result = await rpc(page, 'projectTask.workflow', { worktree, id: task.id })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: known workflow RPC shape is asserted by verifyForkTaskReview and the persisted task below.
    workflow = result as ProjectTaskWorkflow
    await verifyForkTaskReview(
      page,
      root,
      workflow,
      info.outputPath('real-terminal-task-report.png')
    )
    await session.close(app)
    app = undefined
    launched = await session.launch({ executablePath })
    app = launched.app
    page = launched.page
    await verifyForkTaskReview(
      page,
      root,
      workflow,
      info.outputPath('real-terminal-task-report-restarted.png')
    )
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } finally {
    try {
      writeFileSync(
        info.outputPath('real-terminal-task-receipt.json'),
        JSON.stringify({
          turnSubmitted,
          phase: workflow?.phase ?? null,
          attempts: workflow?.attempts.length ?? null,
          reportSaved: Boolean(workflow?.attempts.some((attempt) => attempt.session?.reportPath)),
          scriptedProvider: provider?.receipt(),
          binaryLaunches: existsSync(join(session.userDataDir, 'probe-bin', 'codex-launch.jsonl'))
            ? readFileSync(join(session.userDataDir, 'probe-bin', 'codex-launch.jsonl'), 'utf8')
            : null
        }),
        { mode: 0o600 }
      )
    } finally {
      await provider?.close()
      await session.dispose(app)
      rmSync(root, { recursive: true, force: true })
      rmSync(deniedRoot, { recursive: true, force: true })
    }
  }
})
