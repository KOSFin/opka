import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { serverCliLauncher } from './opka-release-assets.mjs'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'runs the bundled account CLI after relocation with the selected server profile',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'opka relocated server '))
    roots.push(root)
    await mkdir(join(root, 'runtimes'), { recursive: true })
    await mkdir(join(root, 'orcad', 'out', 'cli'), { recursive: true })
    await symlink(process.execPath, join(root, 'runtimes', 'node'))
    await writeFile(join(root, 'opka'), serverCliLauncher('runtimes/node'))
    await writeFile(
      join(root, 'orcad', 'out', 'cli', 'index.js'),
      `console.log(JSON.stringify({
        args: process.argv.slice(2),
        profile: process.env.ORCA_USER_DATA_PATH,
        launcher: process.env.ORCA_CLI_COMMAND,
        nodeOptions: process.env.NODE_OPTIONS,
        externalModule: process.env.NODE_REPL_EXTERNAL_MODULE,
        electron: process.env.ELECTRON_RUN_AS_NODE
      }))`
    )
    const run = (env) =>
      JSON.parse(
        execFileSync('sh', [join(root, 'opka'), 'account', 'add', '--label', 'one\ntwo $name'], {
          cwd: tmpdir(),
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: join(root, 'home'),
            ORCA_USER_DATA: join(root, 'service profile'),
            ORCA_USER_DATA_PATH: '',
            NODE_OPTIONS: '--not-an-allowed-node-flag',
            NODE_REPL_EXTERNAL_MODULE: 'untrusted-module',
            ELECTRON_RUN_AS_NODE: '1',
            ...env
          }
        })
      )
    expect(run({})).toEqual({
      args: ['account', 'add', '--label', 'one\ntwo $name'],
      profile: join(root, 'service profile'),
      launcher: join(root, 'opka')
    })
    expect(run({ ORCA_USER_DATA: '' }).profile).toBe(join(root, 'home', '.opka'))
    expect(run({ ORCA_USER_DATA_PATH: join(root, 'explicit profile') }).profile).toBe(
      join(root, 'explicit profile')
    )
  }
)
