import { hasSameSnapshot } from './cli-command-filesystem-transaction'
import {
  currentMatches,
  homeOf,
  pendingFor,
  mutate,
  restoreAttempted,
  type NativeUserChange
} from './native-cli-user-installation-transaction'
import { unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { planNativeCliUserIntegration } from './native-cli-user-integration'
import { NativeCliIntegrationManifestSchema } from '../../shared/native-cli-unwrapped-command'
import {
  nativeUserInside,
  nativeUserFile,
  nativeUserDigest,
  nativeUserDirectory,
  writeNativeUserPrivate,
  type NativeUserFile
} from './native-cli-user-installation-files'
import {
  canonicalNativeUserPlan,
  nativeUserStateDirectory,
  readNativeUserReceipt,
  writeNativeUserReceipt,
  validateNativeUserTargets,
  clearNativeUserPending,
  type NativeUserInstallOptions,
  type NativeUserReceipt
} from './native-cli-user-installation-state'

export type { NativeUserInstallOptions } from './native-cli-user-installation-state'
type Plan = ReturnType<typeof planNativeCliUserIntegration>
/** Trusted host plan only; there is no remote path, shell command or elevation interface. */
export async function applyNativeCliUserIntegration(
  options: NativeUserInstallOptions & { plan: Plan }
): Promise<{ changed: boolean }> {
  const home = await homeOf(options)
  const files = canonicalNativeUserPlan(home, resolve(options.home), options.plan.files)
  const manifest = files.find((file) => file.path.endsWith('.opka-native-cli.json'))
  if (!manifest) {
    throw new Error('The owned native launcher manifest is required.')
  }
  const bin = dirname(manifest.path)
  const state = await nativeUserStateDirectory(options, home, true)
  validateNativeUserTargets(
    home,
    state,
    files.map((file) => file.path),
    bin
  )
  const declared = NativeCliIntegrationManifestSchema.parse(JSON.parse(manifest.contents))
  for (const provider of ['claude', 'codex'] as const) {
    const file = files.find((file) => file.path === join(bin, provider))
    if (
      !file ||
      !file.contents.startsWith('#!/bin/sh\n# Opka native account launcher v1\n') ||
      nativeUserDigest(file.contents) !== declared.providers[provider].shimSha256 ||
      file.mode !== 0o700 ||
      !isAbsolute(declared.providers[provider].nativeExecutable) ||
      declared.providers[provider].nativeExecutable === bin ||
      nativeUserInside(bin, declared.providers[provider].nativeExecutable)
    ) {
      throw new Error('The native launcher plan is not a verified provider wrapper.')
    }
  }
  if (manifest.mode !== 0o600) {
    throw new Error('The native launcher manifest must be private.')
  }
  const previous = await readNativeUserReceipt(state, home)
  if (
    previous &&
    (previous.binDirectory !== bin ||
      previous.entries.length !== files.length ||
      previous.entries.some((entry) => !files.some((file) => file.path === entry.path)))
  ) {
    throw new Error('Uninstall the previous native launchers before changing installation targets.')
  }
  const current: (NativeUserFile | null)[] = []
  for (const file of files) {
    await nativeUserDirectory(home, dirname(file.path), true)
    current.push(await nativeUserFile(file.path))
  }
  if (current.reduce((sum, file) => sum + (file?.bytes.length ?? 0), 0) > 8 * 1024 * 1024) {
    throw new Error('Native launcher original files exceed the private backup budget.')
  }
  if (
    previous &&
    previous.entries.some(
      (entry) =>
        !currentMatches(
          current[files.findIndex((file) => file.path === entry.path)] ?? null,
          entry.installed
        )
    )
  ) {
    throw new Error(
      'User changes prevent native launcher updates. Files and original backups were preserved.'
    )
  }
  if (
    previous &&
    files.every(
      (file, index) =>
        current[index]?.sha256 === nativeUserDigest(file.contents) &&
        current[index]?.mode === file.mode
    )
  ) {
    return { changed: false }
  }
  for (const [index, file] of files.entries()) {
    if (
      (current[index]?.sha256 ?? null) !== file.expectedSha256 ||
      (current[index] && current[index].mode !== file.mode)
    ) {
      throw new Error('The staged native launcher plan is stale. User files were preserved.')
    }
  }
  const changes: NativeUserChange[] = files.flatMap((file, index) =>
    current[index]?.sha256 === nativeUserDigest(file.contents) && current[index]?.mode === file.mode
      ? []
      : [
          {
            path: file.path,
            before: current[index] ?? null,
            after: { bytes: Buffer.from(file.contents), mode: file.mode }
          }
        ]
  )
  options.assertExclusive()
  const pending = await pendingFor(state, changes, 'apply')
  const entries: NativeUserReceipt['entries'] = []
  const attempted: NativeUserChange[] = []
  let committing = false
  try {
    for (const [index, file] of files.entries()) {
      const prior = previous?.entries.find((entry) => entry.path === file.path)
      const original = current[index]
      if (!previous && original) {
        await writeNativeUserPrivate(join(state, `original-${index}`), original.bytes)
      }
      entries.push({
        path: file.path,
        original: prior
          ? prior.original
          : original
            ? { backup: `original-${index}`, sha256: original.sha256, mode: original.mode }
            : null,
        installed: { sha256: nativeUserDigest(file.contents), mode: file.mode, dev: '0', ino: '0' }
      })
    }
    await mutate(options, home, changes, attempted)
    for (const entry of entries) {
      const file = await nativeUserFile(entry.path)
      if (!file || file.sha256 !== entry.installed.sha256 || file.mode !== entry.installed.mode) {
        throw new Error('Native launcher publication changed before commit.')
      }
      const changed = changes.find((change) => change.path === entry.path)
      const proof = changed
        ? changed.publication
        : current[files.findIndex((item) => item.path === entry.path)]
      if (!proof || !hasSameSnapshot(file.snapshot, proof.snapshot)) {
        throw new Error('The native launcher entry was replaced before commit.')
      }
      entry.installed.dev = file.snapshot.identity.dev.toString()
      entry.installed.ino = file.snapshot.identity.ino.toString()
    }
    options.assertExclusive()
    committing = true
    await writeNativeUserReceipt(state, { version: 1, home, binDirectory: bin, entries })
    await clearNativeUserPending(pending, changes.length)
    return { changed: true }
  } catch (cause) {
    if (!committing) {
      await restoreAttempted(options, home, attempted).catch(() => undefined)
    }
    throw new Error(
      'Native launcher installation did not complete. Private pending evidence and original backups were preserved for recovery.',
      { cause }
    )
  }
}

/** Restores the ORIGINAL pre-integration files; edited or replaced user files are never overwritten. */
export async function rollbackNativeCliUserIntegration(
  options: NativeUserInstallOptions
): Promise<{ changed: boolean }> {
  const home = await homeOf(options)
  let state: string
  try {
    state = await nativeUserStateDirectory(options, home, false)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { changed: false }
    }
    throw error
  }
  const receipt = await readNativeUserReceipt(state, home)
  if (!receipt) {
    return { changed: false }
  }
  const changes: NativeUserChange[] = []
  for (const entry of receipt.entries) {
    await nativeUserDirectory(home, dirname(entry.path), false)
    const before = await nativeUserFile(entry.path)
    if (!currentMatches(before, entry.installed)) {
      throw new Error(
        'User changes prevent automatic native launcher removal. Files and original backups were preserved.'
      )
    }
    const original = entry.original
      ? await nativeUserFile(join(state, entry.original.backup))
      : null
    if (
      entry.original &&
      (!original || original.mode !== 0o600 || original.sha256 !== entry.original.sha256)
    ) {
      throw new Error(
        'The original backup changed before restoration. User files and private backups were preserved.'
      )
    }
    changes.push({
      path: entry.path,
      before,
      after:
        original && entry.original ? { bytes: original.bytes, mode: entry.original.mode } : null
    })
  }
  options.assertExclusive()
  const pending = await pendingFor(state, changes, 'rollback'),
    attempted: NativeUserChange[] = []
  let committing = false
  try {
    await mutate(options, home, changes, attempted)
    options.assertExclusive()
    committing = true
    await unlink(join(state, 'receipt.json'))
    for (const entry of receipt.entries) {
      if (entry.original) {
        await unlink(join(state, entry.original.backup))
      }
    }
    await clearNativeUserPending(pending, changes.length)
    return { changed: true }
  } catch (cause) {
    if (!committing) {
      await restoreAttempted(options, home, attempted).catch(() => undefined)
    }
    throw new Error(
      'Native launcher removal did not complete. Private pending evidence and original backups were preserved for recovery.',
      { cause }
    )
  }
}
