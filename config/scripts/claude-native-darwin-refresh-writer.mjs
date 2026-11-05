import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
function unknown() {
  const error = new Error('Synthetic native writer cleanup is unverified')
  error.nativeCleanupUnverifiable = true
  return error
}
export async function assertDarwinRefreshWriterAbsent(writer, probe = lstat) {
  for (const name of ['writer-owner.json', 'writer-owner.json.next']) {
    try {
      await probe(join(writer, name))
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue
      }
      throw unknown()
    }
    throw unknown()
  }
}
export async function cancelUnstartedDarwinRefresh(options, writer, probe = lstat) {
  try {
    await options.onNotStarted?.()
  } catch {
    throw unknown()
  }
  await assertDarwinRefreshWriterAbsent(writer, probe)
}
