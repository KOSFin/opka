import type { WindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { buildWindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'

export function createHostLoginSpawn(
  managedHomePath: string,
  deviceAuth = false
): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  codexCommand: string
  interactiveLogin: WindowsHostInteractiveLoginSpawn | null
} {
  const codexCommand = resolveCodexCommand()
  const args = deviceAuth ? ['login', '--device-auth'] : ['login']
  // OAuth needs a Windows console; device auth publishes its instructions through captured pipes.
  const interactiveLogin =
    process.platform === 'win32' && !deviceAuth
      ? buildWindowsHostInteractiveLoginSpawn(codexCommand, args)
      : null
  const { spawnCmd, spawnArgs } = interactiveLogin
    ? { spawnCmd: interactiveLogin.command, spawnArgs: interactiveLogin.args }
    : getSpawnArgsForWindows(codexCommand, args)
  return {
    command: spawnCmd,
    args: spawnArgs,
    env: withCliRuntimeOnPath(codexCommand, { ...process.env, CODEX_HOME: managedHomePath }),
    codexCommand,
    interactiveLogin
  }
}
