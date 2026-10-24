import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'launches only the Opka executable and keeps arguments intact through a symlink',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'opka-launcher-')))
    roots.push(root)
    const contents = join(root, 'Opka beta.app', 'Contents')
    const bin = join(contents, 'Resources', 'bin')
    await mkdir(bin, { recursive: true })
    await mkdir(join(contents, 'MacOS'))
    const launcher = join(bin, 'orca')
    await copyFile('resources/darwin/bin/opka', launcher)
    await writeFile(
      join(contents, 'MacOS', 'Opka'),
      '#!/bin/sh\nprintf "%s\\n" "$ORCA_USER_DATA_PATH" "$ORCA_NODE_OPTIONS" "${NODE_OPTIONS-unset}" "$ELECTRON_RUN_AS_NODE" "$@"\n',
      { mode: 0o700 }
    )
    const link = join(root, 'opka')
    await symlink(launcher, link)
    const output = execFileSync('bash', [link, "spaces and quotes '", '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        ORCA_USER_DATA_PATH: '',
        NODE_OPTIONS: '--trace-warnings'
      }
    })
      .trim()
      .split('\n')
    expect(output).toEqual([
      join(root, 'home', 'Library', 'Application Support', 'Opka'),
      '--trace-warnings',
      'unset',
      '1',
      join(contents, 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js'),
      "spaces and quotes '",
      '--json'
    ])
  }
)
