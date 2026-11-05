import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Bound the synthetic probe's own tree; never enumerate a native user home. */
export async function measureOwnedNativeProbeDirectory(root: string) {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Synthetic native source root is not an owned directory.')
  }
  const pending = [root]
  let files = 0,
    bytes = 0,
    links = 0,
    entries = 0
  while (pending.length) {
    const directory = pending.pop()
    if (!directory) {
      break
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 2048) {
        throw new Error('Synthetic native source exceeds the probe inventory limit.')
      }
      const path = join(directory, entry.name),
        stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        links++
        bytes += stat.size
        continue
      }
      if (stat.isDirectory()) {
        pending.push(path)
      } else if (stat.isFile()) {
        files++
        bytes += stat.size
      }
    }
  }
  return { files, bytes, links }
}
