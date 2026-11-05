import { chmod, lstat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { copySessionFileWithoutOverwrite } from '../codex/codex-session-backfill-copy'
import { readEntrySnapshot, hasSameSnapshot } from '../cli/cli-command-filesystem-transaction'
import { nativeUserDirectory, nativeUserInside } from '../cli/native-cli-user-installation-files'
import type { NativeHomeResourcePlan } from './codex-native-home-resources'

const MAX_FALLBACK_BYTES = 1024 ** 3
const HEADROOM = 256 * 1024 ** 2
function cloneUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'ENOTTY'].includes(String(error.code))
  )
}
/** Reflinks create independent inodes; a bounded streaming fallback never links the original. */
export async function copyNativeHomeResources(options: {
  storageRoot: string
  home: string
  plan: NativeHomeResourcePlan
  assertExclusive: () => void
}) {
  const fs = await statfs(options.home, { bigint: true })
  if (fs.bavail * fs.bsize < BigInt(options.plan.bytes + HEADROOM)) {
    throw new Error('Native Codex resource preparation needs more private disk headroom.')
  }
  let copiedBytes = 0,
    clonedFiles = 0,
    copiedFiles = 0
  const unsupportedDevices = new Set<bigint>()
  const deviceSizes = new Map<bigint, number>()
  for (const file of options.plan.files) {
    deviceSizes.set(
      file.snapshot.identity.dev,
      (deviceSizes.get(file.snapshot.identity.dev) ?? 0) + file.size
    )
  }
  for (const file of options.plan.files) {
    const path = join(options.home, file.relativePath)
    if (
      !nativeUserInside(options.home, path) ||
      !hasSameSnapshot(file.snapshot, await readEntrySnapshot(file.sourcePath))
    ) {
      throw new Error('Native Codex resource changed during preparation.')
    }
    await nativeUserDirectory(options.storageRoot, dirname(path), true)
    options.assertExclusive()
    let cloned = false
    if (!unsupportedDevices.has(file.snapshot.identity.dev)) {
      try {
        await copySessionFileWithoutOverwrite(file.sourcePath, path, {
          cloneOnly: true,
          maximumBytes: file.size,
          recoverStages: false
        })
        cloned = true
        clonedFiles++
      } catch (error) {
        if (!cloneUnavailable(error)) {
          throw error
        }
        unsupportedDevices.add(file.snapshot.identity.dev)
      }
    }
    if (!cloned) {
      const deviceBytes = deviceSizes.get(file.snapshot.identity.dev) ?? 0
      if (deviceBytes > MAX_FALLBACK_BYTES || copiedBytes + file.size > MAX_FALLBACK_BYTES) {
        throw new Error(
          'This filesystem cannot clone the native resources within the one-GiB copy budget.'
        )
      }
      await copySessionFileWithoutOverwrite(file.sourcePath, path, {
        maximumBytes: file.size,
        recoverStages: false
      })
      copiedBytes += (await lstat(path)).size
      copiedFiles++
    }
    if (!hasSameSnapshot(file.snapshot, await readEntrySnapshot(file.sourcePath))) {
      throw new Error(
        'Native Codex resource changed during its private copy; preparation was retained for review.'
      )
    }
    options.assertExclusive()
    await chmod(path, file.mode)
  }
  // Mutable operational/plugin OAuth state is intentionally fresh, never imported from the source.
  for (const directory of [
    join(options.home, 'plugins', 'data'),
    join(options.home, 'plugin-state')
  ]) {
    await nativeUserDirectory(options.storageRoot, directory, true)
  }
  return { clonedFiles, copiedFiles, copiedBytes }
}
