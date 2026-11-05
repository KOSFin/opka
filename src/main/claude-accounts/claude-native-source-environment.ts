import process from 'node:process'
import { dirname, isAbsolute } from 'node:path'

/** Native Security must share the execution host's user domain on Darwin. */
export function claudeNativeSourceEnvironment(
  configDir: string,
  nativeUserHome?: string,
  platform: NodeJS.Platform = process.platform
): { HOME: string; CLAUDE_CONFIG_DIR: string } {
  if (!isAbsolute(configDir) || configDir.includes('\0')) {
    throw new Error('Claude native source configuration is unavailable.')
  }
  if (
    platform === 'darwin' &&
    (!nativeUserHome || !isAbsolute(nativeUserHome) || nativeUserHome.includes('\0'))
  ) {
    throw new Error('Claude native host user domain is unavailable.')
  }
  return {
    HOME: platform === 'darwin' && nativeUserHome ? nativeUserHome : dirname(configDir),
    CLAUDE_CONFIG_DIR: configDir
  }
}
