import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareForkProfileNodeCli } from './fork-profile-cli'
import { buildUnixCliLauncher, ensureDevLauncher } from '../../../src/main/cli/cli-dev-launcher'
import { DEV_COMMAND_NAME } from '../../../src/main/cli/cli-install-constants'

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof NodeFs>()),
  existsSync: () => true
}))

it.skipIf(process.platform === 'win32')(
  'restores both canonical Node launchers after desktop boot rewrites them',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'fork-node-launcher-'))
    try {
      const launcher = await prepareForkProfileNodeCli(profile)
      const entry = join(process.cwd(), 'out', 'cli', 'index.js')
      const node = buildUnixCliLauncher(process.execPath, entry, profile, 'node')
      await ensureDevLauncher({
        platform: process.platform,
        userDataPath: profile,
        execPath: `${process.execPath}-synthetic-electron`,
        cliEntryPath: entry,
        commandName: DEV_COMMAND_NAME
      })
      expect(await readFile(launcher, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(await prepareForkProfileNodeCli(profile)).toBe(launcher)
      expect(await readFile(launcher, 'utf8')).toBe(node)
      expect(await readFile(join(profile, 'cli', 'bin', 'orca'), 'utf8')).toBe(node)
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  }
)
