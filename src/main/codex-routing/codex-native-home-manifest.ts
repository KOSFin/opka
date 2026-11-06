import { isAbsolute } from 'node:path'
import { z } from 'zod'

const ConfigState = z
  .object({ sourceHash: z.string().nullable(), publishedHash: z.string() })
  .strict()
export const CodexNativeHomeManifestSchema = z
  .object({
    version: z.literal(1),
    nativeVersion: z.literal('0.166.0'),
    sourceHome: z.string().max(8192).refine(isAbsolute),
    sourcePresent: z.boolean(),
    resources: z.string(),
    resourceBytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 ** 3),
    mutablePluginState: z.literal('fresh'),
    configs: z.record(
      z.string().regex(/^(?:config|[A-Za-z0-9_-]{1,128}\.config)\.toml$/),
      ConfigState
    )
  })
  .strict()

export type CodexNativeHomeManifest = z.infer<typeof CodexNativeHomeManifestSchema>
