import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  readClaudeOAuthCredentials,
  type ClaudeNativeAccess
} from '../rate-limits/claude-oauth-credentials'

export const ClaudeNativeIdentity = z
  .object({
    accountUuid: z.string().min(1).max(200),
    organizationUuid: z.string().min(1).max(200),
    emailAddress: z.string().min(1).max(320)
  })
  .catchall(z.json())
  .superRefine((identity, context) => {
    if (Buffer.byteLength(JSON.stringify(identity)) > 3072) {
      context.addIssue({ code: 'custom', message: 'Native account metadata exceeds its bound.' })
      return
    }
    const pending: unknown[] = [identity]
    let count = 0
    while (pending.length > 0) {
      const value = pending.pop()
      if (++count > 256) {
        context.addIssue({ code: 'custom', message: 'Native account metadata exceeds its bound.' })
        return
      }
      if (!value || typeof value !== 'object') {
        continue
      }
      for (const [key, entry] of Object.entries(value)) {
        if (/(?:access|refresh|auth|id)?_?token$|api_?key|password|secret/i.test(key)) {
          context.addIssue({
            code: 'custom',
            message: 'Native account metadata contains credential fields.'
          })
          return
        }
        pending.push(entry)
      }
    }
  })
export type ClaudeNativeIdentity = z.infer<typeof ClaudeNativeIdentity>
export type ClaudeNativeAccessSnapshot = {
  access: ClaudeNativeAccess
  identity: ClaudeNativeIdentity
}

export function readBoundedClaudeProfileJson(file: string): Record<string, unknown> {
  return readBoundedClaudeProfileSurface(file).value
}

export function readBoundedClaudeProfileSurface(file: string): {
  raw: string
  value: Record<string, unknown>
} {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('Claude native profile surface is unavailable.')
  }
  const raw = readFileSync(file, 'utf8')
  try {
    return { raw, value: z.record(z.string(), z.unknown()).parse(JSON.parse(raw)) }
  } catch {
    throw new Error('Claude native profile JSON is unreadable.')
  }
}

/** The caller resolves and holds the host-owned profile before this read. */
export async function readClaudeNativeAccessSnapshot(
  configDir: string,
  expected: ClaudeNativeIdentity
): Promise<ClaudeNativeAccessSnapshot | null> {
  const credentials = await readClaudeOAuthCredentials({
    credentialsFileConfigDir: configDir,
    keychainConfigDir: configDir,
    includeNativeAccess: true
  })
  if (!credentials.nativeAccess || credentials.unavailable) {
    return null
  }
  try {
    const identity = ClaudeNativeIdentity.parse(
      readBoundedClaudeProfileJson(join(configDir, '.claude.json')).oauthAccount
    )
    if (
      identity.accountUuid !== expected.accountUuid ||
      identity.organizationUuid !== expected.organizationUuid ||
      identity.emailAddress.toLowerCase() !== expected.emailAddress.toLowerCase()
    ) {
      return null
    }
    return { access: credentials.nativeAccess, identity }
  } catch {
    return null
  }
}
