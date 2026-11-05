import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'

const owner = '#!/bin/sh\n# Opka native account launcher v1\n'
const entry = z
  .object({
    nativeExecutable: z.string().max(8192),
    shimSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const NativeCliIntegrationManifestSchema = z
  .object({ version: z.literal(1), providers: z.object({ claude: entry, codex: entry }).strict() })
  .strict()

function isOwnedLauncher(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(Buffer.byteLength(owner))
    return (
      readSync(fd, prefix, 0, prefix.length, 0) === prefix.length && prefix.toString() === owner
    )
  } finally {
    closeSync(fd)
  }
}

function privateRegular(path: string, maxBytes: number, forbiddenMode = 0o022): void {
  const info = lstatSync(path)
  if (
    !info.isFile() ||
    info.size > maxBytes ||
    (info.mode & forbiddenMode) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error('Native launcher ownership is unverifiable.')
  }
}

/** Unwrap only an exact owned launcher; unrelated executables retain native resolution. */
export function resolveUnwrappedNativeCliCommand(
  provider: 'claude' | 'codex',
  command: string
): string {
  if (process.platform === 'win32') {
    return command
  }
  if (!isAbsolute(command) || !isOwnedLauncher(command)) {
    return command
  }
  const resolved = realpathSync(command)
  privateRegular(resolved, 65536)
  const manifestPath = join(dirname(resolved), '.opka-native-cli.json')
  privateRegular(manifestPath, 32768, 0o077)
  const parsed = NativeCliIntegrationManifestSchema.safeParse(
    JSON.parse(readFileSync(manifestPath, 'utf8'))
  )
  if (!parsed.success) {
    throw new Error('Native launcher ownership is unverifiable.')
  }
  const plan = parsed.data.providers[provider]
  const digest = createHash('sha256').update(readFileSync(resolved)).digest('hex')
  if (digest !== plan.shimSha256 || !isAbsolute(plan.nativeExecutable)) {
    throw new Error('Native launcher ownership is unverifiable.')
  }
  const native = realpathSync(plan.nativeExecutable)
  if (
    dirname(native) === dirname(resolved) ||
    !statSync(native).isFile() ||
    isOwnedLauncher(native)
  ) {
    throw new Error('Native launcher resolves recursively.')
  }
  return plan.nativeExecutable
}

export function assertSameNativeCliCommand(
  provider: 'claude' | 'codex',
  command: string,
  expected: string
): void {
  if (!isAbsolute(command) || !isAbsolute(expected)) {
    throw new Error('The qualified native executable is unavailable.')
  }
  const actual = statSync(resolveUnwrappedNativeCliCommand(provider, command), { bigint: true }),
    qualified = statSync(expected, { bigint: true })
  if (
    !actual.isFile() ||
    !qualified.isFile() ||
    actual.dev !== qualified.dev ||
    actual.ino !== qualified.ino
  ) {
    throw new Error('The selected native executable differs from the qualified host CLI.')
  }
}

export function nativeCliExecutableGeneration(command: string): string {
  const path = realpathSync(command),
    info = statSync(path, { bigint: true })
  if (!info.isFile()) {
    throw new Error('Native executable identity is unverifiable.')
  }
  return `${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}
