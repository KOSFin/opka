import { realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { quotePosixShell } from '../../../src/shared/shell-argument-quoting'

export function forkCodexReadableRuntimePaths(): string[] {
  return [
    join(process.cwd(), 'out'),
    join(process.cwd(), 'node_modules'),
    realpathSync(join(process.cwd(), 'node_modules', '@orca', 'process-host')),
    dirname(dirname(process.execPath))
  ]
}

export function prepareForkCodexReadBoundary(bin: string, codex: string, writableRoots?: string[]) {
  const profile = join(bin, 'read-boundary.sb')
  const readable = forkCodexReadableRuntimePaths()
  const writable = writableRoots?.map((path) => realpathSync(path))
  const ancestors = new Set<string>()
  for (const path of readable) {
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
      ancestors.add(parent)
    }
  }
  writeFileSync(
    profile,
    `(version 1)\n(allow default)\n${writable ? `(deny file-write*)\n(allow file-write* (literal "/dev/null") (literal "/dev/tty") ${writable.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')})\n` : ''}(deny file-read* file-write* (subpath ${JSON.stringify(homedir())}))\n${readable.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`).join('\n')}\n${[...ancestors].map((path) => `(allow file-read-metadata (literal ${JSON.stringify(path)}))`).join('\n')}\n`
  )
  const wrapper = join(bin, 'codex')
  writeFileSync(
    wrapper,
    `#!/bin/sh
configured=false
for arg in "$@"; do
  case "$arg" in shell_environment_policy.set.ORCA_CLI_COMMAND=*) configured=true;; esac
done
cli=false; proof=false
[ -z "\${ORCA_CLI_COMMAND:-}" ] || cli=true
[ -z "\${ORCA_TERMINAL_TASK_CALLER_FILE:-}" ] || proof=true
printf '{"cli":%s,"proof":%s,"configured":%s}\\n' "$cli" "$proof" "$configured" >> ${quotePosixShell(join(bin, 'codex-launch.jsonl'))}
exec /usr/bin/sandbox-exec -f ${quotePosixShell(profile)} ${quotePosixShell(codex)} "$@"
`,
    { mode: 0o755 }
  )
  return { profile, wrapper }
}
