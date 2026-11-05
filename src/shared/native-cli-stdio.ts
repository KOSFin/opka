import { z } from 'zod'

const NativeCliStdioReference = z.object({ launchId: z.uuid() }).strict()
export const NativeCliStdioStart = NativeCliStdioReference.extend({
  executable: z.string().min(1).max(8192),
  args: z.array(z.string().max(1024 * 1024)).max(4096),
  cwd: z.string().min(1).max(8192),
  env: z.record(z.string().max(256), z.string().max(1024 * 1024))
}).strict()
export const NativeCliStdioControl = NativeCliStdioReference.extend({
  generation: z.uuid(),
  sequence: z.number().int().nonnegative(),
  inputSequence: z.number().int().positive().optional(),
  input: z.string().max(44_000).optional(),
  eof: z.boolean().optional(),
  signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP']).optional()
}).strict()
export const NativeCliStdioAttach = NativeCliStdioReference.extend({
  generation: z.uuid()
}).strict()
export const NativeCliStdioFrame = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('native-stdio-output'),
      sequence: z.number().int().positive(),
      channel: z.enum(['stdout', 'stderr']),
      bytes: z.string().max(44_000)
    })
    .strict(),
  z
    .object({
      type: z.literal('native-stdio-exit'),
      code: z.number().int().min(0).max(255)
    })
    .strict()
])
export type NativeCliStdioCreated = { launchId: string; generation: string }
export type NativeCliStdioEvent = z.infer<typeof NativeCliStdioFrame>
