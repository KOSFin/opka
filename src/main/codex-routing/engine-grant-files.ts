import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { readCodexAuthIdentity } from '../codex-accounts/codex-auth-identity'
import { ensurePrivateEngineDirectory } from './engine-runtime-config'
import {
  engineCredentialFilename,
  verifyEngineAccountConnection
} from './engine-account-connection'

export type EngineGrantAccount = { id: string; providerAccountId: string; rosterRevision: string }
const Descriptor = z
  .object({
    schemaVersion: z.literal(1),
    accountId: z.uuid(),
    providerAccountId: z.string().min(1),
    rosterRevision: z.string().min(1),
    credentialId: z.string().min(1),
    prefix: z.string(),
    authenticatedAt: z.number().int().positive()
  })
  .strict()
export type EngineGrantDescriptor = z.infer<typeof Descriptor>
const Grant = z
  .object({
    type: z.literal('codex'),
    account_id: z.string().min(1),
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    prefix: z.string().optional(),
    use_siwc: z.literal(false).optional()
  })
  .passthrough()

function readPrivate(path: string, maximum = 256 * 1024): string {
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('Engine grant parent is invalid.')
  }
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > maximum ||
    (process.platform !== 'win32' &&
      [parent, stat].some(
        (metadata) =>
          (metadata.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      ))
  ) {
    throw new Error('Engine grant file is not an owned bounded regular file.')
  }
  return readFileSync(path, 'utf8')
}

function sweepTemporaryFiles(directory: string, names: readonly string[]): void {
  let removed = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (names.some((name) => entry.name.startsWith(`${name}.`) && entry.name.endsWith('.tmp'))) {
      if (++removed > 256 || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Engine grant temporary-file recovery is unavailable.')
      }
      readPrivate(join(directory, entry.name))
      rmSync(join(directory, entry.name))
    }
  }
}

function decodeGrant(contents: string, account: EngineGrantAccount) {
  const grant = Grant.parse(JSON.parse(contents))
  const identity = readCodexAuthIdentity(JSON.stringify({ tokens: { id_token: grant.id_token } }))
  if (!identity?.providerAccountId || identity.providerAccountId !== grant.account_id.trim()) {
    throw new Error('Engine grant identity could not be confirmed.')
  }
  const connection = verifyEngineAccountConnection(account, {
    provider: grant.type,
    providerAccountId: identity.providerAccountId,
    credentialId: engineCredentialFilename(account.id),
    prefix: grant.prefix
  })
  return { grant, connection }
}

export function readStagedEngineGrant(directory: string, account: EngineGrantAccount): string {
  const entries = readdirSync(directory)
  if (entries.length > 16) {
    throw new Error('Unexpected engine enrollment files.')
  }
  const candidates = entries.filter((name) => name.endsWith('.json'))
  if (candidates.length !== 1) {
    throw new Error('No unique fresh engine grant was produced.')
  }
  const { grant, connection } = decodeGrant(readPrivate(join(directory, candidates[0])), account)
  return JSON.stringify({ ...grant, prefix: connection.prefix })
}

/** Token refresh changes file bytes: readiness is bound to immutable identity, never a token hash. */
export function readEngineGrantConnection(
  directory: string,
  account: EngineGrantAccount
): EngineGrantDescriptor | null {
  try {
    const connectionDirectory = join(directory, 'connections', account.id)
    if (existsSync(join(connectionDirectory, 'activation.pending'))) {
      return null
    }
    const descriptor = Descriptor.parse(
      JSON.parse(readPrivate(join(connectionDirectory, 'connection.json'), 8192))
    )
    if (
      descriptor.accountId !== account.id ||
      descriptor.rosterRevision !== account.rosterRevision ||
      descriptor.providerAccountId !== account.providerAccountId
    ) {
      return null
    }
    if (descriptor.credentialId !== engineCredentialFilename(account.id)) {
      return null
    }
    const { grant, connection } = decodeGrant(
      readPrivate(join(directory, 'active-auth', descriptor.credentialId)),
      account
    )
    return grant.prefix === descriptor.prefix && connection.prefix === descriptor.prefix
      ? descriptor
      : null
  } catch {
    return null
  }
}

export function publishEngineGrant(
  directory: string,
  account: EngineGrantAccount,
  contents: string
): EngineGrantDescriptor {
  ensurePrivateEngineDirectory(directory)
  const authDirectory = join(directory, 'active-auth')
  ensurePrivateEngineDirectory(authDirectory)
  ensurePrivateEngineDirectory(join(directory, 'connections'))
  const connectionDirectory = join(directory, 'connections', account.id)
  ensurePrivateEngineDirectory(connectionDirectory)
  const { grant, connection } = decodeGrant(contents, account)
  const published = JSON.stringify({ ...grant, prefix: connection.prefix })
  const descriptor: EngineGrantDescriptor = {
    schemaVersion: 1,
    accountId: account.id,
    providerAccountId: account.providerAccountId,
    rosterRevision: account.rosterRevision,
    credentialId: connection.engineCredentialId,
    prefix: connection.prefix,
    authenticatedAt: Date.now()
  }
  const grantPath = join(authDirectory, descriptor.credentialId)
  const descriptorPath = join(connectionDirectory, 'connection.json')
  const markerPath = join(connectionDirectory, 'activation.pending')
  sweepTemporaryFiles(authDirectory, [descriptor.credentialId])
  sweepTemporaryFiles(connectionDirectory, ['connection.json', 'activation.pending'])
  const hadPending = existsSync(markerPath)
  if (hadPending) {
    readPrivate(markerPath, 64)
  }
  const previous = [grantPath, descriptorPath].map((path) =>
    existsSync(path) ? readPrivate(path) : null
  )
  try {
    writeFileAtomically(markerPath, 'pending', { mode: 0o600 })
    writeFileAtomically(grantPath, published, { mode: 0o600 })
    writeFileAtomically(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 })
    rmSync(markerPath)
  } catch (error) {
    for (const [index, path] of [grantPath, descriptorPath].entries()) {
      const old = previous[index]
      if (old === null) {
        rmSync(path, { force: true })
      } else {
        writeFileAtomically(path, old, { mode: 0o600 })
      }
    }
    if (hadPending) {
      writeFileAtomically(markerPath, 'pending', { mode: 0o600 })
    } else {
      rmSync(markerPath, { force: true })
    }
    throw error
  }
  return descriptor
}

/** Caller has drained native work and proved the engine refresh writer exited. */
export function removeEngineGrantConnection(directory: string, accountId: string): void {
  const credentialId = engineCredentialFilename(accountId)
  const authDirectory = join(directory, 'active-auth')
  const connectionDirectory = join(directory, 'connections', accountId)
  ensurePrivateEngineDirectory(authDirectory)
  ensurePrivateEngineDirectory(connectionDirectory)
  sweepTemporaryFiles(authDirectory, [credentialId])
  sweepTemporaryFiles(connectionDirectory, ['connection.json', 'activation.pending'])
  for (const path of [
    join(authDirectory, credentialId),
    join(connectionDirectory, 'connection.json'),
    join(connectionDirectory, 'activation.pending')
  ]) {
    if (existsSync(path)) {
      readPrivate(path)
      rmSync(path)
    }
  }
  if (readdirSync(connectionDirectory).length === 0) {
    rmSync(connectionDirectory, { recursive: true })
  }
}
