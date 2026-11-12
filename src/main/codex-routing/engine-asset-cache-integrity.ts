import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { z } from 'zod'

export const EngineAssetCacheReceipt = z.object({
  archiveSha256: z.string(),
  archiveBytes: z.number(),
  target: z.string(),
  version: z.string(),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  binaryBytes: z
    .number()
    .int()
    .positive()
    .max(120 * 1024 * 1024)
})
export async function digestEngineAssetFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
