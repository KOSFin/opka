import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { publishFileWithoutOverwrite } from '../codex-accounts/fs-utils'
import { ensurePrivateEngineDirectory } from './engine-runtime-config'
import { NativeCliControlError } from '../../shared/native-cli-control-error'

function isAbsent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function assertNoPending(path: string): void {
  try {
    lstatSync(`${path}.next`)
  } catch (error) {
    if (isAbsent(error)) {
      return
    }
    throw error
  }
  throw new Error('Native gateway credential publication is pending or unverifiable.')
}

function readPrivate(path: string): string | null {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch (error) {
    if (isAbsent(error)) {
      return null
    }
    throw error
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((metadata.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())))
  ) {
    throw new Error('Native gateway credential must be a private owned regular file.')
  }
  const { buffer, stats } = readNodeFileSyncWithinLimit(path, 256, {
    regularFileOnly: true,
    noFollow: true
  })
  const after = lstatSync(path)
  if (
    stats.dev !== metadata.dev ||
    stats.ino !== metadata.ino ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    stats.mode !== metadata.mode ||
    stats.uid !== metadata.uid ||
    after.mode !== metadata.mode ||
    after.uid !== metadata.uid ||
    stats.size !== after.size ||
    stats.mtimeMs !== after.mtimeMs
  ) {
    throw new Error('Native gateway credential changed while being read.')
  }
  return buffer.toString('utf8')
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') {
    return
  }
  const descriptor = openSync(directory, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function publish(
  directory: string,
  path: string,
  contents: string,
  assertExclusive: () => void
): void {
  assertExclusive()
  const stage = `${path}.next`
  const descriptor = openSync(stage, 'wx', 0o600)
  try {
    writeFileSync(descriptor, contents)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  // A crash or lost profile lease leaves one bounded stage, never a replacement credential.
  assertExclusive()
  publishFileWithoutOverwrite(stage, path)
  syncDirectory(directory)
  assertExclusive()
  unlinkSync(stage)
  syncDirectory(directory)
}

function assertKey(key: string): void {
  if (key.length !== 64 || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Native gateway credential format is invalid.')
  }
}

/** One profile-local gateway key; it is never an upstream provider credential. */
export function readOrCreateNativeCodexGatewayCredential(
  directory: string,
  assertExclusive: () => void
): string {
  assertExclusive()
  ensurePrivateEngineDirectory(directory)
  const path = join(directory, 'native-gateway-key')
  assertNoPending(path)
  let key = readPrivate(path)
  if (key === null) {
    publish(directory, path, randomBytes(32).toString('hex'), assertExclusive)
    key = readPrivate(path)
  }
  if (key === null) {
    throw new Error('Native gateway credential publication could not be verified.')
  }
  assertKey(key)
  assertExclusive()
  return key
}

/** Authless routing homes accept only the exact local key; native logins are never replaced. */
export function prepareNativeCodexGatewayAuth(
  home: string,
  key: string,
  assertExclusive: () => void
): void {
  assertExclusive()
  assertKey(key)
  ensurePrivateEngineDirectory(home)
  const path = join(home, 'auth.json')
  const contents = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key })
  const existing = inspectNativeCodexGatewayAuth(home, key, assertExclusive)
  if (existing === 'absent') {
    publish(home, path, contents, assertExclusive)
  }
  if (readPrivate(path) !== contents) {
    throw new NativeCliControlError('routing_auth_conflict')
  }
  assertExclusive()
}

/** Read-only check before native HOME creates its interrupted-preparation marker. */
export function inspectNativeCodexGatewayAuth(
  home: string,
  key: string,
  assertExclusive: () => void
): 'absent' | 'matching' {
  assertExclusive()
  assertKey(key)
  const path = join(home, 'auth.json')
  try {
    assertNoPending(path)
  } catch {
    throw new NativeCliControlError('routing_auth_pending')
  }
  try {
    const existing = readPrivate(path)
    if (existing === null) {
      return 'absent'
    }
    if (existing !== JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key })) {
      throw new NativeCliControlError('routing_auth_conflict')
    }
  } catch (error) {
    if (error instanceof NativeCliControlError) {
      throw error
    }
    throw new NativeCliControlError('routing_auth_conflict')
  }
  assertExclusive()
  return 'matching'
}
