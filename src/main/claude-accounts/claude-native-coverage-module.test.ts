import { NativeClaudeCoverageEvent } from '../../shared/native-claude-coverage'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { transform } from 'esbuild'
import { expect, it } from 'vitest'
import { installClaudeNativeCoverageModule } from './claude-native-coverage-install'
import { createClaudeNativeCoverageModule } from './claude-native-coverage-module'

it('emits a self-contained native ESM module without credentials or copied model input', async () => {
  const source = createClaudeNativeCoverageModule('11111111-1111-4111-8111-111111111111', {
    command: process.execPath,
    args: ['/owned/cli.js']
  })
  await expect(transform(source, { loader: 'js', format: 'esm' })).resolves.toHaveProperty('code')
  expect(source).toContain('native-pool-observe')
  expect(source).toContain("on('classic.SessionStart'")
  expect(source).toContain("on('classic.UserPromptSubmit'")
  expect(source).not.toContain("on('classic.'+")
  expect(source).not.toContain('refreshToken')
  expect(source).not.toContain('accessToken')
  expect(source).not.toContain('.credentials.json')
})

it('installs only a new private facade module and refuses an existing generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opka-native-module-'))
  try {
    const home = join(root, 'facade')
    await mkdir(home)
    const options = {
      home,
      launchId: '11111111-1111-4111-8111-111111111111',
      launch: { command: process.execPath, args: ['/owned/cli.js'] },
      assertExclusive: () => {}
    }
    const installed = installClaudeNativeCoverageModule(options)
    const before = await readFile(join(installed, 'hooks', 'register.js'), 'utf8')
    expect(() => installClaudeNativeCoverageModule(options)).toThrow()
    expect(await readFile(join(installed, 'hooks', 'register.js'), 'utf8')).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('omits absent background work from a successful foreground tool observation', async () => {
  const callbacks = new Map<
    string,
    (api: object, event: object, next: object) => Promise<unknown>
  >()
  const source = createClaudeNativeCoverageModule('11111111-1111-4111-8111-111111111111', {
    command: process.execPath,
    args: ['/owned/cli.js']
  })
  const module: unknown = await import(
    /* @vite-ignore */
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )
  if (
    !module ||
    typeof module !== 'object' ||
    !('register' in module) ||
    typeof module.register !== 'function'
  ) {
    throw new Error('Native module registration missing')
  }
  module.register(
    (name: string, callback: (api: object, event: object, next: object) => Promise<unknown>) => {
      callbacks.set(name, callback)
      return { catch() {} }
    }
  )
  const observations: unknown[] = []
  const api = {
    session: { id: async () => '22222222-2222-4222-8222-222222222222' },
    process: {
      run: async (_args: string[], options: { stdin: string }) => {
        const request = JSON.parse(options.stdin)
        observations.push(NativeClaudeCoverageEvent.parse(request.observation))
        return {
          exitCode: 0,
          stdout: JSON.stringify({ sequence: request.sequence, healthy: true })
        }
      }
    }
  }
  const next = Object.assign(async () => ({ result: { stdout: 'synthetic foreground result' } }), {
    origin: { plugin: 'engine', tier: 'core' }
  })
  const tool = callbacks.get('tool.call')
  if (!tool) {
    throw new Error('Native tool observer missing')
  }
  await tool(api, { tool: 'Bash', tool_use_id: 'actual-foreground-tool' }, next)
  expect(observations.at(-1)).toEqual({ kind: 'tool-end', id: 'actual-foreground-tool' })
})
