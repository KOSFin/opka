import { access, chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { escapeWindowsBatchValue } from './cli-install-path-format'

const marker = 'Orca isolated profile launcher v1'
const resetVariables = [
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'ORCA_APP_EXECUTABLE',
  'ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT',
  'ORCA_PAIRING_CODE',
  'ORCA_REMOTE_PAIRING',
  'ORCA_ENVIRONMENT',
  'ORCA_OPEN_COMMAND',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'ELECTRON_RUN_AS_NODE'
]

export function buildProfileCliLauncher(
  platform: NodeJS.Platform,
  profile: string,
  launcher: string
) {
  const home = join(profile, 'home')
  const values = {
    ORCA_USER_DATA_PATH: profile,
    ORCA_FORK_PROFILE_CLI: '1',
    HOME: home,
    USERPROFILE: home
  }
  if (platform === 'win32') {
    const escape = (value: string) => escapeWindowsBatchValue(value).replaceAll('%', '%%')
    return [
      '@echo off',
      `rem ${marker}`,
      'setlocal DisableDelayedExpansion',
      ...resetVariables.map((name) => `set "${name}="`),
      ...Object.entries(values).map(([name, value]) => `set "${name}=${escape(value)}"`),
      `"${escape(launcher)}" %*`,
      ''
    ].join('\r\n')
  }
  return [
    '#!/usr/bin/env sh',
    `# ${marker}`,
    'set -eu',
    `unset ${resetVariables.join(' ')}`,
    ...Object.entries(values).map(
      ([name, value]) => `export ${name}=${quotePosixShellDoubleQuotedApostrophe(value)}`
    ),
    `exec ${quotePosixShellDoubleQuotedApostrophe(launcher)} "$@"`,
    ''
  ].join('\n')
}

export class ProfileCliRegistration {
  private readonly commandPath: string
  private readonly launcherPath: string | null
  constructor(
    private readonly profile: string,
    resources: string,
    private readonly platform = process.platform
  ) {
    this.commandPath = join(
      profile,
      'cli',
      'bin',
      platform === 'win32' ? 'orca-fork.cmd' : 'orca-fork'
    )
    this.launcherPath = getBundledLauncherPath(platform, resources)
  }

  async getStatus(): Promise<CliInstallStatus> {
    const status: CliInstallStatus = {
      platform: this.platform,
      commandName: 'orca-fork',
      commandPath: this.commandPath,
      pathDirectory: dirname(this.commandPath),
      pathConfigured: false,
      launcherPath: this.launcherPath,
      installMethod: 'wrapper',
      supported: true,
      state: 'not_installed',
      currentTarget: null,
      unsupportedReason: null,
      detail: null,
      registrationScope: 'profile'
    }
    try {
      if (!this.launcherPath) {
        throw new Error('Unsupported platform')
      }
      await access(this.launcherPath, this.platform === 'win32' ? constants.F_OK : constants.X_OK)
    } catch {
      return {
        ...status,
        supported: false,
        state: 'unsupported',
        unsupportedReason: 'launcher_missing',
        detail: 'Build the packaged CLI first.'
      }
    }
    try {
      for (const directory of [join(this.profile, 'cli'), dirname(this.commandPath)]) {
        const parent = await lstat(directory)
        if (!parent.isDirectory() || parent.isSymbolicLink()) {
          return {
            ...status,
            state: 'conflict',
            detail: 'Profile CLI directory is not an owned directory; left unchanged.'
          }
        }
      }
      const entry = await lstat(this.commandPath)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16384) {
        return { ...status, state: 'conflict' }
      }
      const content = await readFile(this.commandPath, 'utf8')
      if (content === buildProfileCliLauncher(this.platform, this.profile, this.launcherPath)) {
        if (this.platform !== 'win32' && (entry.mode & 0o100) === 0) {
          return { ...status, state: 'stale', detail: 'Profile launcher is not executable.' }
        }
        return { ...status, state: 'installed', currentTarget: this.launcherPath }
      }
      return {
        ...status,
        state: 'conflict',
        detail: 'Existing file is not this profile launcher; left unchanged.'
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return status
      }
      throw error
    }
  }

  async install(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (
      !status.supported ||
      status.state === 'conflict' ||
      status.state === 'installed' ||
      !this.launcherPath
    ) {
      return status
    }
    if (status.state === 'stale') {
      await chmod(this.commandPath, 0o700)
      return this.getStatus()
    }
    await mkdir(dirname(this.commandPath), { recursive: true, mode: 0o700 })
    await mkdir(join(this.profile, 'home'), { recursive: true, mode: 0o700 })
    await writeFile(
      this.commandPath,
      buildProfileCliLauncher(this.platform, this.profile, this.launcherPath),
      { flag: 'wx', mode: 0o700 }
    )
    return this.getStatus()
  }

  async remove(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (status.state === 'installed' || status.state === 'stale') {
      await unlink(this.commandPath)
    }
    return this.getStatus()
  }
}
