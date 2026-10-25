import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { buildUnixCliLauncher, ensureDevLauncher } from '../../../src/main/cli/cli-dev-launcher'
import { DEV_COMMAND_NAME } from '../../../src/main/cli/cli-install-constants'

export async function prepareForkProfileCli(
  userDataPath: string,
  executablePath: string
): Promise<string> {
  const launcher = await ensureDevLauncher({
    platform: process.platform,
    userDataPath,
    execPath: executablePath,
    cliEntryPath: join(process.cwd(), 'out', 'cli', 'index.js'),
    commandName: DEV_COMMAND_NAME
  })
  if (!launcher) {
    throw new Error('Build the fork CLI before launching this isolated development profile')
  }
  return launcher
}

export async function prepareForkProfileNodeCli(userDataPath: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error('The isolated Node CLI probe requires a POSIX launcher')
  }
  const launcher = await prepareForkProfileCli(userDataPath, process.execPath)
  const content = buildUnixCliLauncher(
    process.execPath,
    join(process.cwd(), 'out', 'cli', 'index.js'),
    userDataPath,
    'node'
  )
  await writeFile(launcher, content, { mode: 0o755 })
  await writeFile(join(userDataPath, 'cli', 'bin', 'orca'), content, { mode: 0o755 })
  return launcher
}
