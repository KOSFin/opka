import { lstat, mkdir, readdir, rename, unlink, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { bestEffortFsyncDirectorySync } from '../../shared/secure-file'
import {
  nativeUserDirectory,
  nativeUserFile,
  nativeUserInside,
  writeNativeUserPrivate
} from './native-cli-user-installation-files'
import type { NativeCliUserIntegrationFile } from './native-cli-user-integration'

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Mode = z
  .number()
  .int()
  .min(0)
  .max(0o777)
  .refine((mode) => (mode & 0o022) === 0 && (mode & 0o600) === 0o600)
const Previous = z
  .object({ backup: z.string().regex(/^original-(?:[0-9]|1[0-5])$/), sha256: Hash, mode: Mode })
  .strict()
export const NativeUserReceipt = z
  .object({
    version: z.literal(1),
    home: z.string().max(8192),
    binDirectory: z.string().max(8192),
    entries: z
      .array(
        z
          .object({
            path: z.string().max(8192),
            installed: z
              .object({
                sha256: Hash,
                mode: Mode,
                dev: z.string().regex(/^\d+$/),
                ino: z.string().regex(/^\d+$/)
              })
              .strict(),
            original: Previous.nullable()
          })
          .strict()
      )
      .min(3)
      .max(16)
  })
  .strict()
export type NativeUserReceipt = z.infer<typeof NativeUserReceipt>
export type NativeUserInstallOptions = {
  home: string
  stateDirectory: string
  assertExclusive: () => void
}
const profiles = new Set([
  '.profile',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.zshrc',
  '.zprofile',
  '.zshenv'
])
export function validateNativeUserTargets(
  home: string,
  state: string,
  paths: string[],
  bin: string
): void {
  if (
    paths.length < 3 ||
    paths.length > 16 ||
    new Set(paths).size !== paths.length ||
    !nativeUserInside(home, bin) ||
    nativeUserInside(bin, state) ||
    nativeUserInside(state, bin) ||
    bin === state
  ) {
    throw new Error('The native launcher target set is invalid.')
  }
  const commands = [join(bin, 'claude'), join(bin, 'codex'), join(bin, '.opka-native-cli.json')]
  if (commands.some((path) => !paths.includes(path))) {
    throw new Error('Both native launchers and their owned manifest are required.')
  }
  for (const path of paths) {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      /[\0\r\n]/.test(path) ||
      !nativeUserInside(home, path) ||
      path === state ||
      nativeUserInside(state, path) ||
      (!commands.includes(path) && (!profiles.has(basename(path)) || nativeUserInside(bin, path)))
    ) {
      throw new Error(
        'Only native launcher files and supported user shell profiles may be installed.'
      )
    }
  }
}
export function canonicalNativeUserPlan(
  home: string,
  originalHome: string,
  files: NativeCliUserIntegrationFile[]
) {
  if (
    files.length > 16 ||
    files.reduce((sum, file) => sum + Buffer.byteLength(file.contents), 0) > 8 * 1024 * 1024
  ) {
    throw new Error('Native launcher installation exceeds its bounded file budget.')
  }
  return files.map((file) => {
    if (
      !isAbsolute(file.path) ||
      !nativeUserInside(originalHome, file.path) ||
      /[\0\r\n]/.test(file.path) ||
      Buffer.byteLength(file.contents) > 1024 * 1024 ||
      !Mode.safeParse(file.mode).success ||
      (file.expectedSha256 !== null && !Hash.safeParse(file.expectedSha256).success) ||
      file.backupRequired !== (file.expectedSha256 !== null)
    ) {
      throw new Error('Native launcher installation plan is invalid.')
    }
    return { ...file, path: join(home, relative(originalHome, file.path)) }
  })
}
export async function nativeUserStateDirectory(
  options: NativeUserInstallOptions,
  home: string,
  create: boolean
): Promise<string> {
  if (
    !isAbsolute(options.stateDirectory) ||
    /[\0\r\n]/.test(options.stateDirectory) ||
    !nativeUserInside(options.home, options.stateDirectory)
  ) {
    throw new Error('Native launcher private state must be inside the configured home.')
  }
  const state = join(home, relative(options.home, options.stateDirectory))
  await nativeUserDirectory(home, state, create)
  const info = await lstat(state)
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Native launcher backup storage must be private.')
  }
  const names = await readdir(state)
  if (
    names.length > 18 ||
    names.some((name) => name !== 'receipt.json' && !/^original-(?:[0-9]|1[0-5])$/.test(name))
  ) {
    throw new Error(
      'Native launcher recovery is pending or private state contains unknown entries. Preserve the backups.'
    )
  }
  return state
}
export async function readNativeUserReceipt(
  state: string,
  home: string
): Promise<NativeUserReceipt | null> {
  const file = await nativeUserFile(join(state, 'receipt.json'))
  if (!file) {
    if ((await readdir(state)).length !== 0) {
      throw new Error(
        'Native launcher private backups have no verified receipt. Preserve them for recovery.'
      )
    }
    return null
  }
  try {
    if (file.mode !== 0o600 || file.bytes.length > 256 * 1024) {
      throw new Error('private receipt')
    }
    const receipt = NativeUserReceipt.parse(JSON.parse(file.bytes.toString('utf8')))
    if (receipt.home !== home) {
      throw new Error('home changed')
    }
    validateNativeUserTargets(
      home,
      state,
      receipt.entries.map((entry) => entry.path),
      receipt.binDirectory
    )
    const backups = receipt.entries.flatMap((entry) =>
      entry.original ? [entry.original.backup] : []
    )
    if (new Set(backups).size !== backups.length) {
      throw new Error('duplicate backup')
    }
    let total = 0
    for (const entry of receipt.entries) {
      if (!entry.original) {
        continue
      }
      const original = await nativeUserFile(join(state, entry.original.backup))
      total += original?.bytes.length ?? 0
      if (
        !original ||
        total > 8 * 1024 * 1024 ||
        original.mode !== 0o600 ||
        original.sha256 !== entry.original.sha256
      ) {
        throw new Error('backup changed')
      }
    }
    return receipt
  } catch {
    throw new Error(
      'Native launcher rollback evidence is unverifiable. Preserve the private backups.'
    )
  }
}
export async function writeNativeUserReceipt(
  state: string,
  receipt: NativeUserReceipt
): Promise<void> {
  const path = join(state, 'receipt.next')
  await writeNativeUserPrivate(path, JSON.stringify(receipt))
  await rename(path, join(state, 'receipt.json'))
  bestEffortFsyncDirectorySync(state)
}
export async function createNativeUserPending(state: string, operation: unknown): Promise<string> {
  const pending = join(state, 'pending')
  await mkdir(pending, { mode: 0o700 })
  await writeNativeUserPrivate(join(pending, 'operation.json'), JSON.stringify(operation))
  bestEffortFsyncDirectorySync(state)
  return pending
}
export async function clearNativeUserPending(pending: string, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await unlink(join(pending, `before-${index}`))
  }
  await unlink(join(pending, 'operation.json'))
  await rmdir(pending)
  bestEffortFsyncDirectorySync(dirname(pending))
}
