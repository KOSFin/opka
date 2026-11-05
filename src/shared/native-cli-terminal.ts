import { z } from 'zod'
import { TerminalViewport } from './rpc-contract/terminal-unary-params'
export const NATIVE_CLI_PTY_CHILD_ENV = 'ORCA_NATIVE_CLI_PTY_CHILD'
export const NativeCliTerminalCreate = z
  .object({
    launchId: z.uuid(),
    provider: z.enum(['claude', 'codex']),
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    env: z.record(z.string(), z.string()),
    codexWorkingDirectory: z.string().min(1).max(8192).optional(),
    codexModelCatalogPath: z.string().min(1).max(8192).optional(),
    codexResumeSessionId: z.uuid().optional(),
    codexProfile: z.string().min(1).max(256).optional(),
    codexModelProvider: z.string().min(1).max(256).optional(),
    cols: TerminalViewport.shape.cols,
    rows: TerminalViewport.shape.rows
  })
  .strict()
export const NativeCliTerminalReference = z.object({ launchId: z.uuid() }).strict()
export const NativeCliTerminalInput = NativeCliTerminalReference.extend({
  incarnationId: z.string().min(1),
  text: z.string().max(8192)
}).strict()
export const NativeCliTerminalResize = NativeCliTerminalReference.extend({
  cols: TerminalViewport.shape.cols,
  rows: TerminalViewport.shape.rows
}).strict()
export type NativeCliTerminalCreated = { launchId: string; paneKey: string; worktreeId: string }
