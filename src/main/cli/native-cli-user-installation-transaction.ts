import { hasSameSnapshot } from './cli-command-filesystem-transaction'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  nativeUserFile,
  nativeUserDirectory,
  nativeUserDigest,
  replaceNativeUserFile,
  writeNativeUserPrivate,
  type NativeUserFile
} from './native-cli-user-installation-files'
import {
  createNativeUserPending,
  type NativeUserInstallOptions,
  type NativeUserReceipt
} from './native-cli-user-installation-state'

export type NativeUserChange = {
  path: string
  before: NativeUserFile | null
  publication?: NativeUserFile | null
  after: { bytes: Buffer; mode: number } | null
}
function unix(): void {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('Native user launcher installation supports Unix execution hosts only.')
  }
}
export function currentMatches(
  file: NativeUserFile | null,
  installed: NativeUserReceipt['entries'][number]['installed']
): boolean {
  return (
    file !== null &&
    file.sha256 === installed.sha256 &&
    file.mode === installed.mode &&
    file.snapshot.identity.dev.toString() === installed.dev &&
    file.snapshot.identity.ino.toString() === installed.ino
  )
}
export async function homeOf(options: NativeUserInstallOptions): Promise<string> {
  unix()
  options.assertExclusive()
  if (!isAbsolute(options.home) || /[\0\r\n]/.test(options.home)) {
    throw new Error('An explicit execution-host home is required.')
  }
  const home = await realpath(options.home)
  await nativeUserDirectory(home, home, false)
  return home
}
export async function pendingFor(
  state: string,
  changes: NativeUserChange[],
  kind: 'apply' | 'rollback'
): Promise<string> {
  const pending = await createNativeUserPending(state, {
    version: 1,
    kind,
    entries: changes.map((change) => ({
      path: change.path,
      before: change.before ? { sha256: change.before.sha256, mode: change.before.mode } : null,
      after: change.after
        ? { sha256: nativeUserDigest(change.after.bytes), mode: change.after.mode }
        : null
    }))
  })
  for (const [index, change] of changes.entries()) {
    await writeNativeUserPrivate(
      join(pending, `before-${index}`),
      change.before?.bytes ?? Buffer.alloc(0)
    )
  }
  return pending
}
export async function mutate(
  options: NativeUserInstallOptions,
  home: string,
  changes: NativeUserChange[],
  attempted: NativeUserChange[]
): Promise<void> {
  for (const change of changes) {
    attempted.push(change)
    change.publication = await replaceNativeUserFile({
      ...change,
      home,
      assertExclusive: options.assertExclusive
    })
  }
}
export async function restoreAttempted(
  options: NativeUserInstallOptions,
  home: string,
  attempted: NativeUserChange[]
): Promise<void> {
  let incomplete = false
  for (const change of attempted.toReversed()) {
    try {
      const current = await nativeUserFile(change.path)
      if (
        (current?.sha256 ?? null) === (change.before?.sha256 ?? null) &&
        (current?.mode ?? null) === (change.before?.mode ?? null)
      ) {
        continue
      }
      const proof = change.publication
      if (
        proof === undefined ||
        (proof === null
          ? current !== null
          : !current ||
            current.sha256 !== proof.sha256 ||
            current.mode !== proof.mode ||
            !hasSameSnapshot(current.snapshot, proof.snapshot))
      ) {
        throw new Error(
          'The native launcher publication changed or was not proven; recovery preserves the user entry.'
        )
      }
      await replaceNativeUserFile({
        home,
        path: change.path,
        before: current,
        after: change.before,
        assertExclusive: options.assertExclusive
      })
    } catch {
      incomplete = true
    }
  }
  if (incomplete) {
    throw new Error(
      'User changes or unavailable ownership prevent complete native launcher recovery.'
    )
  }
}
