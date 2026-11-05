import { lstat, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep, dirname } from 'node:path'
import { copySessionFileWithoutOverwrite } from '../codex/codex-session-backfill-copy'
import { readCodexRolloutSessionMetaId } from '../codex/codex-rollout-session-meta'
import { parseCodexRolloutThreadId } from '../codex/codex-session-index-heal-state'
import { readEntrySnapshot, hasSameSnapshot } from '../cli/cli-command-filesystem-transaction'
import { nativeUserDirectory, nativeUserInside } from '../cli/native-cli-user-installation-files'
import { nativeHomeMissing } from './codex-native-home-inputs'

export type CodexNativeHomeAdoption = { sourceHome: string; transcriptPath: string }
export async function adoptCodexNativeHistory(options: {
  storageRoot: string
  home: string
  adopt: CodexNativeHomeAdoption
  assertExclusive: () => void
}) {
  const sourceRoot = await realpath(join(options.adopt.sourceHome, 'sessions'))
  const source = resolve(options.adopt.transcriptPath)
  const relativePath = relative(sourceRoot, source)
  const dateParts = relativePath.split(sep)
  const thread = parseCodexRolloutThreadId(source)
  if (
    !nativeUserInside(sourceRoot, source) ||
    dateParts.length !== 4 ||
    !/^\d{4}$/.test(dateParts[0]) ||
    !/^\d{2}$/.test(dateParts[1]) ||
    !/^\d{2}$/.test(dateParts[2]) ||
    !source.endsWith('.jsonl') ||
    !thread ||
    (await realpath(source)) !== source
  ) {
    throw new Error(
      'Native Codex history adoption requires an existing dated rollout inside its trusted source HOME.'
    )
  }
  const info = await lstat(source)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.size > 256 * 1024 * 1024 ||
    (info.mode & 0o022) !== 0 ||
    (await readCodexRolloutSessionMetaId(source)) !== thread.threadId
  ) {
    throw new Error('Native Codex history identity or size could not be verified.')
  }
  const target = join(options.home, 'sessions', relativePath)
  await nativeUserDirectory(options.storageRoot, dirname(target), true)
  let existing
  try {
    existing = await lstat(target)
  } catch (error) {
    if (!nativeHomeMissing(error)) {
      throw error
    }
  }
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      existing.uid !== process.getuid?.() ||
      (await readCodexRolloutSessionMetaId(target)) !== thread.threadId
    ) {
      throw new Error('Existing owned native Codex history has an unverified identity.')
    }
  } else {
    const before = await readEntrySnapshot(source)
    options.assertExclusive()
    await copySessionFileWithoutOverwrite(source, target, { maximumBytes: info.size })
    if (
      !hasSameSnapshot(before, await readEntrySnapshot(source)) ||
      (await readCodexRolloutSessionMetaId(target)) !== thread.threadId
    ) {
      throw new Error(
        'Original native Codex history changed during adoption; prepared files were preserved for review.'
      )
    }
  }
  return { ...thread, transcriptPath: target }
}
