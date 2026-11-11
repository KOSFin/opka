import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { nativeCliStartupFixture } from './native-cli-startup-fixture'
import { prepareNativeCliStartup } from './native-cli-startup-prepare'
import { NativeCliAccountLaunchV2Params } from '../../shared/native-cli-account-launch'
import {
  NativeCliControlError,
  nativeCliControlErrorReply
} from '../../shared/native-cli-control-error'
import { TERMINAL_TASK_CALLER_FILE_ENV } from '../../shared/terminal-task-caller-env'
const prepare = vi.hoisted(() => vi.fn())
vi.mock('./native-cli-account-launch', () => ({ prepareNativeCliAccountLaunch: prepare }))

it('starts a real wrapper process, then refuses preparation before any native/model process', async () => {
  const f = nativeCliStartupFixture()
  let spawned = false
  let prepareObserved = false
  const executable = process.execPath
  const marker = join(f.root, 'model-request')
  const wrapper = join(f.root, 'wrapper.cjs')
  const modulePath = fileURLToPath(new URL('../../cli/native-agent-exec.ts', import.meta.url))
  await build({
    stdin: {
      resolveDir: dirname(modulePath),
      loader: 'ts',
      contents: `import { runNativeAgentExec } from ${JSON.stringify(modulePath)};
const client = { call: (method, params) => new Promise((resolve, reject) => {
  process.send({method, params}); process.once('message', reply => reply.error ? reject(new Error(reply.error.message)) : resolve(reply));
}) };
void runNativeAgentExec(client, ['codex', ${JSON.stringify(executable)}, '-e', ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"model requested")`)}]).then(() => { process.exitCode = 0 }, () => { process.exitCode = 23 });
`
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: wrapper,
    external: ['electron'],
    logLevel: 'silent'
  })
  prepare.mockImplementation(async () => {
    prepareObserved = true
    expect(spawned).toBe(true)
    throw new NativeCliControlError('config_conflict')
  })
  const child = spawnProcess({
    program: process.execPath,
    args: [wrapper],
    cwd: f.root,
    env: {
      PATH: process.env.PATH,
      NODE_PATH: join(process.cwd(), 'node_modules'),
      HOME: f.root,
      USERPROFILE: f.root,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_USER_DATA_PATH: f.root,
      [TERMINAL_TASK_CALLER_FILE_ENV]: f.path,
      ORCA_AGENT_LAUNCH_TOKEN: f.request.startup.launchToken,
      ORCA_WORKTREE_ID: f.pty.worktreeId
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const schema = z.object({ method: z.string(), params: z.unknown() })
  let diagnostic = ''
  child.stderr?.on('data', (data) => {
    diagnostic += String(data)
  })
  child.once('spawn', () => {
    spawned = true
  })
  child.on('message', (message) => {
    const call = schema.parse(message)
    expect(call.method).toBe('accounts.prepareNativeCliLaunchV2')
    const params = NativeCliAccountLaunchV2Params.parse(call.params)
    void prepareNativeCliStartup(f.runtime, params).then(
      (result) => child.send?.({ result }),
      (error: unknown) => child.send?.({ error: nativeCliControlErrorReply(error) })
    )
  })
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    expect(diagnostic).toBe('')
    expect(exit).toBe(23)
    expect(prepareObserved).toBe(true)
    expect(f.startup.refusal?.code).toBe('native_cli_config_conflict')
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
    expect(prepare).toHaveBeenCalledTimes(1)
  } finally {
    child.kill()
    f.dispose()
  }
}, 20_000)
