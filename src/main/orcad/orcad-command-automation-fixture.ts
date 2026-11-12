import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import { z } from 'zod'
import { getDefaultPersistedState } from '../../shared/constants'
import { parsePairingCode } from '../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY } from '../../shared/automation-runtime-capabilities'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import { isFinalAutomationRunStatus, type AutomationRun } from '../../shared/automations-types'
import { orcadNodeRuntimeRelativePath } from '../../shared/orcad-artifacts'
import {
  killChildAndWait,
  killProfileDaemons,
  removeTestRoot
} from './orcad-daemon-teardown-fixture'

const Ready = z.object({
  runtimeId: z.string().uuid(),
  pairing: z.object({ available: z.literal(true), url: z.string() })
})

export function createCommandAutomationFixture(packagePath: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-command-automation-'))
  const home = join(root, 'home')
  const userData = join(root, 'data')
  const workspace = join(root, 'folder')
  for (const directory of [home, userData, workspace]) {
    mkdirSync(directory, { mode: 0o700 })
  }
  const state = getDefaultPersistedState(home)
  state.settings = { ...state.settings, agentStatusHooksEnabled: false }
  writeFileSync(join(userData, 'orca-data.json'), JSON.stringify(state), { mode: 0o600 })
  const slot = resolve(packagePath)
  const runtime = resolve(
    slot,
    ...orcadNodeRuntimeRelativePath(
      'linux-x64-glibc',
      NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256
    )
  )
  let running: ReturnType<typeof spawnProcess> | null = null
  let connection: PairedRuntimeConnection | null = null
  let pairingUrl: string | null = null
  let runtimeId: string | null = null

  async function start(): Promise<void> {
    if (running) {
      throw new Error('Fixture server is already running')
    }
    const child = spawnProcess({
      program: runtime,
      args: [join(slot, 'orcad.js'), '--bind', '127.0.0.1', '--port', '0', '--json'],
      cwd: home,
      env: {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        PATH: [dirname(runtime), '/usr/bin', '/bin'].join(':'),
        SHELL: '/bin/sh',
        LANG: 'C.UTF-8',
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_TELEMETRY_DISABLED: '1',
        ORCA_DIAGNOSTICS_DISABLED: '1',
        ORCA_USER_DATA: userData,
        ORCA_USER_DATA_PATH: userData
      },
      timeoutMs: null
    })
    running = child
    connection = await new Promise((settle, reject) => {
      let output = ''
      const timer = setTimeout(
        () => reject(new Error('Isolated server readiness timed out')),
        40_000
      )
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Isolated server exited before readiness (${code})`))
      })
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.length > 64 * 1024) {
          clearTimeout(timer)
          reject(new Error('Server readiness output exceeded its budget'))
        }
        const newline = output.indexOf('\n')
        if (newline === -1) {
          return
        }
        clearTimeout(timer)
        try {
          const ready = Ready.parse(JSON.parse(output.slice(0, newline)))
          const offer = parsePairingCode(ready.pairing.url)
          if (!offer) {
            throw new Error('Invalid isolated pairing offer')
          }
          pairingUrl = ready.pairing.url
          runtimeId = ready.runtimeId
          settle(pairedRuntimeConnectionFromOffer(offer))
        } catch {
          reject(new Error('Invalid isolated server readiness'))
        }
      })
      child.stderr.resume()
    })
  }

  async function call<T>(method: string, params: unknown, modern = true): Promise<T> {
    if (!connection) {
      throw new Error('Fixture server is not paired')
    }
    const response = await sendRemoteRuntimeRequest<T>(
      connection,
      method,
      params,
      20_000,
      undefined,
      undefined,
      modern ? [AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY] : []
    )
    if (!response.ok) {
      throw new Error(`${method}: ${response.error.code}: ${response.error.message}`)
    }
    if (response._meta.runtimeId !== runtimeId) {
      throw new Error('RPC response belongs to another execution host')
    }
    return response.result
  }

  async function commandList(): Promise<unknown> {
    if (!pairingUrl) {
      throw new Error('The fixture server has no pairing offer')
    }
    const result = await runProcess({
      program: runtime,
      args: [
        join(slot, 'out/cli/index.js'),
        'automations',
        'command',
        'list',
        '--pairing-code',
        pairingUrl,
        '--json'
      ],
      cwd: home,
      env: {
        HOME: home,
        PATH: [dirname(runtime), '/usr/bin', '/bin'].join(':'),
        ORCA_USER_DATA_PATH: userData,
        ORCA_BACKGROUND_LAUNCH: '1'
      },
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0) {
      throw new Error(`Packaged command CLI refused (${result.code})`)
    }
    const reply = z
      .object({ ok: z.literal(true), _meta: z.object({ runtimeId: z.string() }) })
      .passthrough()
      .parse(JSON.parse(result.stdout))
    if (reply._meta.runtimeId !== runtimeId) {
      throw new Error('CLI response belongs to another execution host')
    }
    return reply
  }

  async function stop(): Promise<void> {
    if (running) {
      await killChildAndWait(running)
      running = null
      connection = null
    }
  }

  async function cancelUnsettledCommands(): Promise<void> {
    if (!running || !connection) {
      return
    }
    const listed = await call<{ commandAutomations?: { id: string }[] }>('automation.list', {})
    for (const definition of listed.commandAutomations ?? []) {
      const params = { automationId: definition.id, expectedOwner: { selector: { kind: 'self' } } }
      const history = await call<{ runs: AutomationRun[] }>('automation.runs', params)
      for (const run of history.runs.filter((entry) => !isFinalAutomationRunStatus(entry.status))) {
        await call('automation.cancelRunV1', {
          version: 1,
          id: definition.id,
          runId: run.id,
          expectedOwner: params.expectedOwner,
          requestKey: `fixture-cleanup-${run.id}`
        })
        const deadline = Date.now() + 20_000
        let exited = false
        while (!exited && Date.now() < deadline) {
          const current = await call<{ runs: AutomationRun[] }>('automation.runs', params)
          exited = current.runs.some(
            (entry) =>
              entry.id === run.id &&
              entry.commandExecution?.observation === 'exited' &&
              isFinalAutomationRunStatus(entry.status)
          )
          if (!exited) {
            await new Promise((done) => setTimeout(done, 50))
          }
        }
        if (!exited) {
          throw new Error('Isolated command cleanup is unverifiable; preserve the test profile')
        }
      }
    }
  }

  async function dispose(): Promise<void> {
    try {
      await cancelUnsettledCommands()
    } catch (error) {
      writeFileSync(
        join(root, 'cleanup-receipt.json'),
        JSON.stringify({
          category: 'isolated_command_cleanup_unverifiable',
          profilePreserved: true
        }),
        { mode: 0o600 }
      )
      await stop()
      throw error
    }
    await stop()
    await killProfileDaemons(userData)
    await removeTestRoot(root)
  }
  return { root, workspace, start, stop, call, commandList, dispose, runtimeId: () => runtimeId }
}
