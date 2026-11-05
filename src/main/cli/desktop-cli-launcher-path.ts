import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { ensureLinuxTerminalOrcaCliShimDir } from './linux-terminal-orca-cli-shim'
import { DEV_COMMAND_NAME, DEV_LAUNCHER_DIR } from './cli-install-constants'

let preparedLinux: { userDataPath: string; resourcesPath: string; directory: string } | null = null
export function prepareDesktopLinuxCliLauncher(options: {
  userDataPath: string
  resourcesPath: string
}): void {
  preparedLinux = null
  const directory = ensureLinuxTerminalOrcaCliShimDir({
    ...options,
    appImageCacheRootPath: join(options.userDataPath, 'cli', 'appimage')
  })
  if (directory) {
    preparedLinux = { ...options, directory }
  }
}
function readPreparedLinuxShim(options: {
  userDataPath: string
  resourcesPath: string
}): string | null {
  return preparedLinux?.userDataPath === options.userDataPath &&
    preparedLinux.resourcesPath === options.resourcesPath
    ? preparedLinux.directory
    : null
}

/** Uses this app's existing child launchers, preserving the parent agent environment. */
export function desktopCliLauncherPath(
  options: {
    platform: NodeJS.Platform
    packaged: boolean
    resourcesPath: string | undefined
    userDataPath: string
  },
  dependencies = { exists: existsSync, linuxShim: readPreparedLinuxShim }
): string | null {
  if (!options.packaged) {
    const path = join(
      options.userDataPath,
      ...DEV_LAUNCHER_DIR,
      options.platform === 'win32' ? `${DEV_COMMAND_NAME}.cmd` : DEV_COMMAND_NAME
    )
    return dependencies.exists(path) ? path : null
  }
  if (!options.resourcesPath) {
    return null
  }
  if (options.platform === 'linux') {
    const directory = dependencies.linuxShim({
      userDataPath: options.userDataPath,
      resourcesPath: options.resourcesPath
    })
    return directory ? join(directory, 'orca') : null
  }
  const path = getBundledLauncherPath(options.platform, options.resourcesPath)
  return path && dependencies.exists(path) ? path : null
}
