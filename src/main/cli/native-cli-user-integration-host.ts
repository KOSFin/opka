import { access, realpath, stat, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveCliCommands } from '../../shared/node-cli-command-resolution'
import { resolveUnwrappedNativeCliCommand } from '../../shared/native-cli-unwrapped-command'
import { planNativeCliUserIntegration } from './native-cli-user-integration'
import {
  applyNativeCliUserIntegration,
  rollbackNativeCliUserIntegration
} from './native-cli-user-installation'
import { nativeUserFile, nativeUserInside } from './native-cli-user-installation-files'
import {
  nativeUserStateDirectory,
  readNativeUserReceipt
} from './native-cli-user-installation-state'
import { currentMatches } from './native-cli-user-installation-transaction'

export type NativeCliUserIntegrationStatus = {
  supported: boolean
  state: 'not-installed' | 'installed' | 'modified' | 'unverifiable' | 'unsupported'
  missing: ('claude' | 'codex' | 'orca')[]
  binDirectory: string | null
  profileFiles: string[]
}
export type NativeCliUserIntegrationHostOptions = {
  profileRoot: string
  dataRoot: string
  assertExclusive: () => void
  home: () => string
  cliLauncher: () => string | null
  zdotdir?: () => string | undefined
  resolveCommands?: typeof resolveCliCommands
}
const unix = () => process.platform === 'linux' || process.platform === 'darwin'
const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
async function runnable(path: string | null | undefined, owned = false): Promise<boolean> {
  if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) {
    return false
  }
  try {
    const info = await stat(path)
    if (
      !info.isFile() ||
      (owned && ((info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid?.())))
    ) {
      return false
    }
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
async function profileInfo(path: string) {
  try {
    const info = await lstat(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.size > 1024 * 1024 ||
      (info.mode & 0o022) !== 0 ||
      (info.mode & 0o600) !== 0o600
    ) {
      throw new Error(
        'Native command setup requires owned regular shell profiles. User files were preserved.'
      )
    }
    return { path, exists: true, mode: info.mode & 0o777 }
  } catch (error) {
    if (absent(error)) {
      return { path, exists: false, mode: 0o600 }
    }
    throw error
  }
}
async function shellProfiles(home: string, zdotdir?: string) {
  const zsh = zdotdir ? resolve(zdotdir) : home
  if (zdotdir && (!isAbsolute(zdotdir) || (zsh !== home && !nativeUserInside(home, zsh)))) {
    throw new Error('Custom ZDOTDIR must be an absolute directory inside this host user home.')
  }
  const profiles = [
    await profileInfo(join(home, '.profile')),
    await profileInfo(join(home, '.bashrc'))
  ]
  for (const name of ['.bash_profile', '.bash_login']) {
    const login = await profileInfo(join(home, name))
    if (login.exists) {
      profiles.push(login)
      break
    }
  }
  profiles.push(await profileInfo(join(zsh, '.zshenv')))
  for (const name of ['.zprofile', '.zshrc']) {
    const profile = await profileInfo(join(zsh, name))
    if (profile.exists) {
      profiles.push(profile)
    }
  }
  return profiles
}

/** No constructor/boot writes: only explicit owning-host operations can change shell files. */
export class NativeCliUserIntegrationHost {
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  private busy = false
  constructor(private readonly options: NativeCliUserIntegrationHostOptions) {}
  private async paths() {
    this.options.assertExclusive()
    const home = await realpath(this.options.home())
    const profileRoot = await realpath(this.options.profileRoot)
    const dataRoot = await realpath(this.options.dataRoot)
    const scope = createHash('sha256').update(profileRoot).digest('hex')
    return {
      home,
      profileRoot,
      dataRoot,
      binDirectory: join(home, '.local', 'share', 'opka-native-cli', scope, 'bin'),
      stateDirectory: join(home, '.local', 'state', 'opka-native-cli', scope)
    }
  }
  private async prerequisites(home: string) {
    const commands = (this.options.resolveCommands ?? resolveCliCommands)(['claude', 'codex'], {
      homePath: home
    })
    const providers = { claude: '', codex: '' },
      missing: NativeCliUserIntegrationStatus['missing'] = []
    for (const provider of ['claude', 'codex'] as const) {
      try {
        const found = commands.get(provider)
        if (!found || !isAbsolute(found)) {
          throw new Error('not found')
        }
        const native = resolveUnwrappedNativeCliCommand(provider, found)
        if (!(await runnable(native))) {
          throw new Error('not executable')
        }
        providers[provider] = native
      } catch {
        missing.push(provider)
      }
    }
    const launcher = this.options.cliLauncher()
    if (!(await runnable(launcher, true))) {
      missing.push('orca')
    }
    return { providers, launcher, missing }
  }
  async status(): Promise<NativeCliUserIntegrationStatus> {
    const result: NativeCliUserIntegrationStatus = {
      supported: unix(),
      state: unix() ? 'not-installed' : 'unsupported',
      missing: [],
      binDirectory: null,
      profileFiles: []
    }
    if (!unix()) {
      return result
    }
    try {
      const paths = await this.paths()
      result.binDirectory = paths.binDirectory
      result.missing = (await this.prerequisites(paths.home)).missing
      result.profileFiles = (await shellProfiles(paths.home, this.options.zdotdir?.())).map(
        (profile) => profile.path
      )
      let state
      try {
        state = await nativeUserStateDirectory(
          { ...paths, assertExclusive: this.options.assertExclusive },
          paths.home,
          false
        )
      } catch (error) {
        if (absent(error)) {
          return result
        }
        throw error
      }
      const receipt = await readNativeUserReceipt(state, paths.home)
      if (!receipt) {
        return result
      }
      for (const entry of receipt.entries) {
        if (!currentMatches(await nativeUserFile(entry.path), entry.installed)) {
          return { ...result, state: 'modified' }
        }
      }
      return { ...result, state: 'installed' }
    } catch {
      return { ...result, state: 'unverifiable' }
    }
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy || this.closing) {
      return Promise.reject(new Error('Native command setup is busy or shutting down.'))
    }
    this.busy = true
    const next = Promise.resolve()
      .then(() => {
        if (this.closing) {
          throw new Error('Native command setup is shutting down.')
        }
        return operation()
      })
      .finally(() => {
        this.busy = false
      })
    this.tail = next.catch(() => undefined)
    return next
  }
  install(signal?: AbortSignal): Promise<NativeCliUserIntegrationStatus> {
    return this.serialized(async () => {
      if (!unix()) {
        throw new Error('Native command setup supports Unix execution hosts only.')
      }
      signal?.throwIfAborted()
      const paths = await this.paths(),
        prerequisites = await this.prerequisites(paths.home)
      if (prerequisites.missing.length || !prerequisites.launcher) {
        throw new Error(
          'Install both native Claude and Codex CLIs and prepare this host’s owned Orca launcher before enabling ordinary commands.'
        )
      }
      const selected = await shellProfiles(paths.home, this.options.zdotdir?.())
      const profiles: Parameters<typeof planNativeCliUserIntegration>[0]['profiles'] = []
      for (const profile of selected) {
        const file = await nativeUserFile(profile.path)
        const contents = file?.bytes.toString('utf8') ?? null
        if (file && !Buffer.from(contents ?? '').equals(file.bytes)) {
          throw new Error('Shell profiles must be UTF-8 text. Original bytes were preserved.')
        }
        profiles.push({ path: profile.path, contents, mode: file?.mode ?? profile.mode })
      }
      const previous = async (name: string) =>
        (await nativeUserFile(join(paths.binDirectory, name)))?.bytes.toString('utf8')
      const plan = planNativeCliUserIntegration({
        platform: process.platform,
        home: paths.home,
        binDirectory: paths.binDirectory,
        cliExecutable: prerequisites.launcher,
        userDataPath: paths.dataRoot,
        nativeExecutables: prerequisites.providers,
        profiles,
        previousShims: { claude: await previous('claude'), codex: await previous('codex') },
        previousManifest: await previous('.opka-native-cli.json')
      })
      signal?.throwIfAborted()
      await applyNativeCliUserIntegration({
        ...paths,
        plan,
        assertExclusive: this.options.assertExclusive
      })
      return this.status()
    })
  }
  uninstall(signal?: AbortSignal): Promise<NativeCliUserIntegrationStatus> {
    return this.serialized(async () => {
      if (!unix()) {
        throw new Error('Native command setup supports Unix execution hosts only.')
      }
      signal?.throwIfAborted()
      const paths = await this.paths()
      await rollbackNativeCliUserIntegration({
        ...paths,
        assertExclusive: this.options.assertExclusive
      })
      return this.status()
    })
  }
  shutdown(): Promise<void> {
    this.closing = true
    return this.tail.then(
      () => undefined,
      () => undefined
    )
  }
}
