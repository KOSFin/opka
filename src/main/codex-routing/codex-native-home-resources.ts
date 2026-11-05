import { lstat, opendir, realpath } from 'node:fs/promises'
import { join, sep, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readEntrySnapshot, type EntrySnapshot } from '../cli/cli-command-filesystem-transaction'
import { nativeUserInside } from '../cli/native-cli-user-installation-files'
import { nativeHomeDigest, nativeHomeMissing } from './codex-native-home-inputs'

const entries = [
  'skills',
  'hooks',
  'hooks.json',
  'plugins',
  'profile-v2',
  'themes',
  'prompts',
  'AGENTS.md'
] as const
export const NATIVE_RESOURCE_MAX_BYTES = 2 * 1024 ** 3
export const NATIVE_RESOURCE_MAX_FILE_BYTES = 512 * 1024 ** 2
export type NativeHomeResource = {
  relativePath: string
  sourcePath: string
  snapshot: EntrySnapshot
  mode: number
  size: number
}
export type NativeHomeResourcePlan = { files: NativeHomeResource[]; bytes: number; digest: string }
const inside = (root: string, path: string) => root === path || nativeUserInside(root, path)
/** Inspect metadata once; mutable plugin data and credentials never enter this static seed. */
export async function planNativeHomeResources(
  sourceHome: string,
  additionalRoots: readonly string[] = []
): Promise<NativeHomeResourcePlan> {
  const files: NativeHomeResource[] = []
  const global = join(homedir(), '.codex')
  const roots = [
    ...entries.map((name) => join(sourceHome, name)),
    ...entries.map((name) => join(global, name)),
    join(homedir(), '.agents', 'skills'),
    ...additionalRoots.map((root) => resolve(root))
  ]
  const mutable = [
    join(sourceHome, 'plugins', 'data'),
    join(sourceHome, 'plugin-state'),
    join(global, 'plugins', 'data'),
    join(global, 'plugin-state')
  ]
  let count = 0,
    total = 0
  async function walk(
    relativePath: string,
    sourcePath: string,
    depth: number,
    ancestors: ReadonlySet<string>
  ): Promise<void> {
    if (depth > 32 || ++count > 32768) {
      throw new Error('Native Codex resource inventory exceeds its preparation bound.')
    }
    if (
      relativePath === join('plugins', 'data') ||
      relativePath.startsWith(`plugins${sep}data${sep}`)
    ) {
      return
    }
    let info
    try {
      info = await lstat(sourcePath)
    } catch (error) {
      if (nativeHomeMissing(error)) {
        return
      }
      throw error
    }
    if (info.isSymbolicLink()) {
      const target = await realpath(sourcePath)
      if (
        !roots.some((root) => inside(root, target)) ||
        mutable.some((root) => inside(root, target))
      ) {
        throw new Error(
          'Native Codex resource ownership needs an explicit safe import; source files were preserved.'
        )
      }
      await walk(relativePath, target, depth + 1, ancestors)
      return
    }
    if ((info.uid !== process.getuid?.() && info.uid !== 0) || (info.mode & 0o022) !== 0) {
      throw new Error(
        'Native Codex resource ownership is unavailable; source files were preserved.'
      )
    }
    const identity = `${info.dev}:${info.ino}`
    if (info.isDirectory()) {
      if (ancestors.has(identity)) {
        throw new Error('Native Codex resource links contain a cycle.')
      }
      const next = new Set(ancestors)
      next.add(identity)
      const directory = await opendir(sourcePath)
      for await (const entry of directory) {
        await walk(join(relativePath, entry.name), join(sourcePath, entry.name), depth + 1, next)
      }
      return
    }
    if (
      !info.isFile() ||
      info.size > NATIVE_RESOURCE_MAX_FILE_BYTES ||
      (relativePath === 'hooks.json' && info.size > 1024 * 1024)
    ) {
      throw new Error('Native Codex static resource exceeds its regular-file bound.')
    }
    total += info.size
    if (total > NATIVE_RESOURCE_MAX_BYTES) {
      throw new Error('Native Codex static resources exceed the two-GiB preparation bound.')
    }
    const snapshot = await readEntrySnapshot(sourcePath)
    if (!snapshot || snapshot.isSymbolicLink) {
      throw new Error('Native Codex static resource changed during inspection.')
    }
    files.push({
      relativePath,
      sourcePath,
      snapshot,
      mode: 0o600 | (info.mode & 0o100),
      size: info.size
    })
  }
  for (const name of entries) {
    await walk(name, join(sourceHome, name), 0, new Set())
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const digest = nativeHomeDigest(
    JSON.stringify(
      files.map((file) => [
        file.relativePath,
        file.sourcePath,
        file.mode,
        Object.values(file.snapshot.identity).map((value) => value.toString())
      ])
    )
  )
  return { files, bytes: total, digest }
}
