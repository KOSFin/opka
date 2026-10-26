import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { TERMINAL_TASK_CALLER_FILE_ENV } from './terminal-task-caller-env'

export const TerminalTaskCallerFile = z
  .object({
    schema: z.literal(1),
    proof: z.string().regex(/^[a-f0-9]{64}$/),
    identity: z
      .object({
        terminalHandle: z.string().min(1).max(512),
        paneKey: z.string().min(1).max(1024),
        worktreeId: z.string().min(1).max(4096),
        processIncarnation: z.string().min(1).max(4096)
      })
      .strict()
      .optional()
  })
  .strict()

export type TerminalTaskCallerRecord = z.infer<typeof TerminalTaskCallerFile>

export function terminalTaskCallerPath(profile: string, ptyId: string): string {
  return join(
    profile,
    'terminal-task-callers',
    `${createHash('sha256').update(ptyId).digest('hex')}.json`
  )
}

export function readTerminalTaskCallerFile(path: string): TerminalTaskCallerRecord | null {
  try {
    const directory = lstatSync(dirname(path))
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      lstatSync(path).isSymbolicLink()
    ) {
      return null
    }
    const { buffer, stats } = readNodeFileSyncWithinLimit(path, 16 * 1024, {
      regularFileOnly: true,
      noFollow: true
    })
    if (
      process.platform !== 'win32' &&
      ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())
    ) {
      return null
    }
    const parsed = TerminalTaskCallerFile.safeParse(JSON.parse(buffer.toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function readInjectedTerminalTaskCaller(
  env: NodeJS.ProcessEnv
): TerminalTaskCallerRecord | null {
  const path = env[TERMINAL_TASK_CALLER_FILE_ENV]
  const profile = env.ORCA_USER_DATA_PATH
  if (
    !path ||
    !profile ||
    dirname(resolve(path)) !== resolve(profile, 'terminal-task-callers') ||
    !/^[a-f0-9]{64}\.json$/.test(path.split(/[\\/]/).at(-1) ?? '')
  ) {
    return null
  }
  return readTerminalTaskCallerFile(path)
}
