import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { CODEX_NO_DAEMON_SKIP_ARGS } from '../../shared/codex-shell-function'
import { isPathInsideOrEqual } from './cli-install-path-format'
import { NativeCliIntegrationManifestSchema } from '../../shared/native-cli-unwrapped-command'

const START = '# >>> Opka native account launchers >>>'
const END = '# <<< Opka native account launchers <<<'
const FINAL_START = '# >>> Opka native account launchers final PATH >>>'
const FINAL_END = '# <<< Opka native account launchers final PATH <<<'
const OWNER = '# Opka native account launcher v1'

export type NativeCliUserIntegrationFile = {
  path: string
  contents: string
  mode: number
  expectedSha256: string | null
  backupRequired: boolean
}

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function readPreviousManifest(value: string | null | undefined) {
  if (value == null) {
    return null
  }
  try {
    return NativeCliIntegrationManifestSchema.parse(JSON.parse(value))
  } catch {
    throw new Error('Refusing to replace an unverified native launcher manifest')
  }
}

function absolute(value: string): void {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error('Native CLI integration requires absolute paths without control characters')
  }
}

function withoutOwnedProfileBlock(
  previous: string,
  startMarker: string,
  endMarker: string,
  separator = false
): string {
  let start = previous.indexOf(startMarker)
  const end = previous.indexOf(endMarker)
  if (
    (start === -1) !== (end === -1) ||
    (start !== -1 &&
      (end < start ||
        previous.includes(startMarker, start + startMarker.length) ||
        previous.includes(endMarker, end + endMarker.length)))
  ) {
    throw new Error('The existing integration block is incomplete or duplicated')
  }
  if (start === -1) {
    return previous
  }
  if (separator && previous[start - 1] === '\n') {
    start--
  }
  return previous.slice(0, start) + previous.slice(end + endMarker.length).replace(/^\r?\n/, '')
}

/** Generates reviewable files only; applying them requires ownership checks and private backups. */
export function planNativeCliUserIntegration(args: {
  platform: NodeJS.Platform
  home: string
  binDirectory: string
  cliExecutable: string
  userDataPath: string
  nativeExecutables: { claude: string; codex: string }
  profiles: { path: string; contents: string | null; mode: number }[]
  previousShims?: Partial<Record<'claude' | 'codex', string>>
  previousManifest?: string | null
}): {
  files: NativeCliUserIntegrationFile[]
  uninstall: { path: string; expectedSha256: string; restoreBackup: boolean }[]
} {
  if (args.platform !== 'linux' && args.platform !== 'darwin') {
    throw new Error('This integration plan supports Unix user shells only')
  }
  for (const path of [
    args.home,
    args.binDirectory,
    args.cliExecutable,
    args.userDataPath,
    ...Object.values(args.nativeExecutables)
  ]) {
    absolute(path)
  }
  if (
    !isPathInsideOrEqual(args.home, args.binDirectory) ||
    args.home === args.binDirectory ||
    args.binDirectory.includes(':')
  ) {
    throw new Error(
      'The launcher directory must be a separate PATH entry inside the configured user home'
    )
  }
  const files: NativeCliUserIntegrationFile[] = []
  const previousManifest = readPreviousManifest(args.previousManifest)
  for (const provider of ['claude', 'codex'] as const) {
    const native = args.nativeExecutables[provider]
    if (isPathInsideOrEqual(args.binDirectory, native)) {
      throw new Error('The native executable must be outside the managed launcher directory')
    }
    const previous = args.previousShims?.[provider]
    if (previous !== undefined && !previous.startsWith(`#!/bin/sh\n${OWNER}\n`)) {
      throw new Error('Refusing to replace an executable not owned by this integration')
    }
    if (
      previous !== undefined &&
      previousManifest &&
      digest(previous) !== previousManifest.providers[provider].shimSha256
    ) {
      throw new Error('Refusing to replace a modified native account launcher')
    }
    const isolate =
      provider === 'codex'
        ? `isolate=1
for arg in "$@"; do
  case "$arg" in ${CODEX_NO_DAEMON_SKIP_ARGS.join('|')}|--remote=*) isolate=0 ;; esac
done
if [ "$isolate" = 1 ]; then
  case "$(${quotePosixShell(native)} --help 2>/dev/null </dev/null)" in *--no-daemon*) set -- --no-daemon "$@" ;; esac
fi
`
        : ''
    const contents = `#!/bin/sh
${OWNER}
for opka_context in "\${ORCA_CLI_COMMAND-}" "\${ORCA_NATIVE_CLI_LAUNCHER-}"; do
  if [ -n "$opka_context" ] && [ "$opka_context" != ${quotePosixShell(args.cliExecutable)} ] && ! [ "$opka_context" -ef ${quotePosixShell(args.cliExecutable)} ]; then
    exec ${quotePosixShell(native)} "$@"
  fi
done
if [ -n "\${ORCA_USER_DATA_PATH-}" ] && [ "$ORCA_USER_DATA_PATH" != ${quotePosixShell(args.userDataPath)} ] && ! [ "$ORCA_USER_DATA_PATH" -ef ${quotePosixShell(args.userDataPath)} ]; then
  exec ${quotePosixShell(native)} "$@"
fi
export ORCA_USER_DATA_PATH=${quotePosixShell(args.userDataPath)}
export ORCA_NATIVE_CLI_LAUNCHER=${quotePosixShell(args.cliExecutable)}
${isolate}exec ${quotePosixShell(args.cliExecutable)} agent native-exec ${provider} ${quotePosixShell(native)} "$@"
`
    files.push({
      path: join(args.binDirectory, provider),
      contents,
      mode: 0o700,
      expectedSha256: previous === undefined ? null : digest(previous),
      backupRequired: previous !== undefined
    })
  }
  const prioritizePath = `opka_native_rest="\${PATH:-/usr/bin:/bin}:"
opka_native_path=${quotePosixShell(args.binDirectory)}
while [ -n "$opka_native_rest" ]; do
  opka_native_entry=\${opka_native_rest%%:*}
  opka_native_rest=\${opka_native_rest#*:}
  if [ "$opka_native_entry" != ${quotePosixShell(args.binDirectory)} ]; then
    opka_native_path="$opka_native_path:$opka_native_entry"
  fi
done
export PATH="$opka_native_path"
unset opka_native_rest opka_native_path opka_native_entry
`
  for (const profile of args.profiles) {
    absolute(profile.path)
    if (!isPathInsideOrEqual(args.home, profile.path)) {
      throw new Error('Shell profiles must belong to the configured user home')
    }
    const previous = profile.contents ?? ''
    const rest = withoutOwnedProfileBlock(
      withoutOwnedProfileBlock(previous, START, END),
      FINAL_START,
      FINAL_END,
      true
    )
    files.push({
      path: profile.path,
      // Entry covers SSH's early return; the final block follows NVM/Homebrew PATH changes.
      contents: `${START}\n${prioritizePath}${END}\n${rest}\n${FINAL_START}\n${prioritizePath}${FINAL_END}\n`,
      mode: profile.mode,
      expectedSha256: profile.contents === null ? null : digest(previous),
      backupRequired: profile.contents !== null
    })
  }
  const providers = {
    claude: {
      nativeExecutable: args.nativeExecutables.claude,
      shimSha256: digest(files[0].contents)
    },
    codex: { nativeExecutable: args.nativeExecutables.codex, shimSha256: digest(files[1].contents) }
  }
  files.push({
    path: join(args.binDirectory, '.opka-native-cli.json'),
    contents: `${JSON.stringify(NativeCliIntegrationManifestSchema.parse({ version: 1, providers }))}\n`,
    mode: 0o600,
    expectedSha256: args.previousManifest == null ? null : digest(args.previousManifest),
    backupRequired: args.previousManifest != null
  })
  return {
    files,
    uninstall: files.map((file) => ({
      path: file.path,
      expectedSha256: digest(file.contents),
      restoreBackup: file.backupRequired
    }))
  }
}
