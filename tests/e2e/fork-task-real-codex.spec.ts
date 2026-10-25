import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { prepareForkProfileNodeCli } from './helpers/fork-profile-cli'
import { probeForkCodexStartup } from './helpers/fork-codex-startup'
import { respondToForkTaskApprovals } from './helpers/fork-task-approvals'
import { verifyForkTaskReview } from './helpers/fork-task-review'
import type { AgentSessionHistoryResult } from '../../src/shared/agent-session-wire'
import {
  structuredAgentSessionCreateParams,
  createStructuredAgentSessionId
} from '../../src/shared/structured-agent-session-create'
import { projectTaskTemplate } from '../../src/shared/project-task-template'
import type { ProjectTaskWorkflow } from '../../src/shared/project-task-workflow'
import type { ProjectTaskEntry } from '../../src/shared/project-task-contract'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const executablePath = process.env.ORCA_FORK_AUDIT_ELECTRON
const enabled = process.env.ORCA_REAL_CODEX_TASK_SMOKE === '1'
test.skip(
  !enabled || !executablePath || process.platform !== 'darwin',
  'Explicit opt-in, isolated Electron and macOS read boundary required'
)
test.use({ trace: 'off', screenshot: 'off' })

async function rpc<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  const reply = await page.evaluate((request) => window.api.runtime.call(request), {
    method,
    params
  })
  if (!reply.ok) {
    throw new Error(`${method}: ${reply.error.message}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this opt-in fixture calls known RPCs and asserts their observable effects below.
  return reply.result as T
}

test('one real Codex chat discovers a task, saves a report and requests review', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  expect(testRepoPath).toBeTruthy()
  const source = process.env.ORCA_REAL_CODEX_AUTH_FILE
  const codex = process.env.ORCA_REAL_CODEX_BINARY
  if (!source || !codex || !lstatSync(source).isFile() || !existsSync(codex)) {
    throw new Error(
      'Explicit existing Codex binary and credential-file path required; credentials are never printed'
    )
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opka-real-card-')))
  const session = createRestartSession(testInfo, {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1'
  })
  let app: ElectronApplication | undefined
  let workflow: ProjectTaskWorkflow | undefined
  let turnSubmitted = false
  let turnObserved = false
  let approvedCommands = 0
  const startedAt = Date.now()
  try {
    if (!executablePath) {
      throw new Error('An explicit test Electron executable is required')
    }
    const cli = await prepareForkProfileNodeCli(session.userDataDir)
    const home = join(session.userDataDir, 'home')
    const codexHome = join(home, '.codex')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    // Reuse only the approved login, never user instructions, MCP servers or plugins.
    copyFileSync(source, join(codexHome, 'auth.json'))
    chmodSync(join(codexHome, 'auth.json'), 0o600)
    writeFileSync(
      join(codexHome, 'config.toml'),
      'model_reasoning_effort="low"\nweb_search="disabled"\n[features]\nmulti_agent=false\n'
    )
    const bin = join(session.userDataDir, 'probe-bin')
    const probeEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      ORCA_ENVIRONMENT: '',
      ORCA_PAIRING_CODE: '',
      ORCA_REMOTE_PAIRING: ''
    }
    mkdirSync(bin)
    const profile = join(bin, 'read-boundary.sb')
    const readable = [
      join(process.cwd(), 'out'),
      join(process.cwd(), 'node_modules'),
      realpathSync(join(process.cwd(), 'node_modules', '@orca', 'process-host')),
      dirname(dirname(process.execPath))
    ]
    const ancestors = new Set<string>()
    for (const path of readable) {
      for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
        ancestors.add(parent)
      }
    }
    writeFileSync(
      profile,
      `(version 1)\n(allow default)\n(deny file-read* file-write* (subpath ${JSON.stringify(homedir())}))\n${readable.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`).join('\n')}\n${[...ancestors].map((path) => `(allow file-read-metadata (literal ${JSON.stringify(path)}))`).join('\n')}\n`
    )
    const wrapper = join(bin, 'codex')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(profile)} ${quote(codex)} "$@"\n`,
      { mode: 0o755 }
    )
    const denied = runProcessSync({
      program: '/usr/bin/sandbox-exec',
      args: ['-f', profile, '/bin/ls', homedir()],
      cwd: root,
      maxOutputBytes: 1024,
      timeoutMs: 5000
    })
    expect(denied.code).not.toBe(0)
    expect(denied.stdout).toBe('')
    const version = runProcessSync({
      program: wrapper,
      args: ['--version'],
      cwd: root,
      env: probeEnv,
      maxOutputBytes: 1024,
      timeoutMs: 10000
    })
    expect(version.code, 'Codex must run under the read boundary before any inference').toBe(0)
    const cliVersion = runProcessSync({
      program: '/usr/bin/sandbox-exec',
      args: ['-f', profile, cli, '--version'],
      cwd: root,
      env: probeEnv,
      maxOutputBytes: 1024,
      timeoutMs: 10000
    })
    expect(
      cliVersion.code,
      `The actual profile CLI must run under the same read boundary before any inference: ${JSON.stringify(cliVersion)}`
    ).toBe(0)
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# Synthetic test project\nWork only in this directory. No network, GitHub, SSH, other projects, credential inspection, extra agents or dependency installs. Use apply_patch for source edits.\n'
    )
    writeFileSync(join(root, 'sum.mjs'), 'export function add(a, b) { return a - b }\n')
    writeFileSync(
      join(root, 'sum.test.mjs'),
      "import {test} from 'node:test'\nimport {strict as assert} from 'node:assert'\nimport {add} from './sum.mjs'\ntest('adds positive values',()=>assert.equal(add(2,3),5))\ntest('adds negative values',()=>assert.equal(add(-4,1),-3))\n"
    )
    const launched = await session.launch({
      executablePath,
      extraEnv: { PATH: `${bin}:${process.env.PATH ?? ''}` }
    })
    app = launched.app
    const page = launched.page
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
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
      await window
        .__store!.getState()
        .updateSettings({ experimentalNativeChat: true, defaultTuiAgent: 'codex' })
      return `folder:${folder.id}`
    }, root)
    await rpc(page, 'projectTask.init', { worktree, expectedExecutionHostId: 'local' })
    const task = await rpc<ProjectTaskEntry>(page, 'projectTask.create', {
      worktree,
      expectedExecutionHostId: 'local',
      source: 'project',
      slug: 'addition',
      content: projectTaskTemplate({
        id: `task-${randomUUID()}`,
        title: 'Исправить сложение',
        goal: 'Исправить add в sum.mjs, не менять тесты. Проверить node --test sum.test.mjs: 2+3=5 и -4+1=-3. Сохранить фактические проверки и результат для ревью.'
      })
    })
    await rpc(page, 'projectTask.approve', {
      worktree,
      id: task.id,
      revision: task.revision,
      expectedExecutionHostId: 'local'
    })
    const board = runProcessSync({
      program: '/usr/bin/sandbox-exec',
      args: ['-f', profile, cli, 'project-task', 'board', '--json'],
      cwd: root,
      env: probeEnv,
      maxOutputBytes: 16384,
      timeoutMs: 10000
    })
    expect(
      board.code,
      `The own-profile CLI must discover the current task before inference: ${board.stderr.slice(0, 2000)} ${board.stdout.slice(0, 2000)}`
    ).toBe(0)
    expect(board.stdout).toContain('Исправить сложение')
    await probeForkCodexStartup(wrapper, root, probeEnv)
    if (process.env.ORCA_REAL_CODEX_PREFLIGHT_ONLY === '1') {
      testInfo.annotations.push({ type: 'preflight-only', description: 'No model turn submitted' })
      console.info('task-smoke: preflight only, no model turn submitted')
      return
    }
    const sessionId = createStructuredAgentSessionId('codex', randomUUID)
    const params = structuredAgentSessionCreateParams({
      sessionId,
      worktree,
      agent: 'codex',
      randomUuid: randomUUID,
      options: { permissionMode: 'ask' },
      firstMessage: {
        clientMessageId: randomUUID(),
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Выполни карточку «Исправить сложение» в этом проекте.' }]
        }
      }
    })
    console.info('task-smoke: submitting the single approved model prompt')
    await rpc(page, 'agentSession.create', params)
    turnSubmitted = true
    await expect
      .poll(
        async () => {
          const history = await rpc<AgentSessionHistoryResult>(page, 'agentSession.history', {
            sessionId,
            direction: 'tail'
          })
          if (JSON.stringify(history).includes('providerStartFailed')) {
            throw new Error(
              'Codex failed before starting its turn; inspect the synthetic startup path'
            )
          }
          turnObserved ||= !!history.page.latestTurn
          approvedCommands += await respondToForkTaskApprovals(
            history.page,
            root,
            (method, params) => rpc(page, method, params)
          )
          workflow = await rpc<ProjectTaskWorkflow>(page, 'projectTask.workflow', {
            worktree,
            id: task.id
          })
          return workflow.phase
        },
        { timeout: 180000, intervals: [1000] }
      )
      .toBe('review')
    await verifyForkTaskReview(
      page,
      root,
      workflow,
      testInfo.outputPath('real-codex-task-report.png')
    )
  } finally {
    try {
      const receiptPath = testInfo.outputPath('task-smoke-receipt.json')
      mkdirSync(dirname(receiptPath), { recursive: true })
      writeFileSync(
        receiptPath,
        JSON.stringify({
          elapsedMs: Date.now() - startedAt,
          turnSubmitted,
          turnObserved,
          approvedCommands,
          phase: workflow?.phase ?? null,
          attempts: workflow?.attempts.length ?? null,
          reportSaved: !!workflow?.attempts.some((attempt) => attempt.session?.reportPath)
        }),
        { mode: 0o600 }
      )
      await testInfo.attach('task-smoke-receipt', {
        contentType: 'application/json',
        path: receiptPath
      })
    } finally {
      await session.dispose(app)
      rmSync(root, { recursive: true, force: true })
    }
  }
})
