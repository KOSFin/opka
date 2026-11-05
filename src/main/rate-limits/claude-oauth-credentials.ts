import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'
import { readUserClaudeConfigDir } from '../claude-accounts/claude-profile-paths'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'

export type ClaudeOAuthCredentialSource =
  | 'scoped-keychain'
  | 'legacy-keychain'
  | 'credentials-file'
  | 'none'
export type ClaudeOAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  source: ClaudeOAuthCredentialSource
  keychainUnavailable?: boolean
  unavailable?: boolean
  nativeAccess?: ClaudeNativeAccess
}
export type ClaudeNativeAccess = {
  accessToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
  rateLimitTier?: string
}
type ClaudeOAuthCredentialReadOptions = {
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
  /** System Default only: a managed profile never reads another login's item. */
  unsuffixedKeychainFallback?: boolean
  includeNativeAccess?: boolean
}
const nativeAccessSchema = z.object({
  accessToken: z.string().min(1).max(32768),
  expiresAt: z.number().finite().positive(),
  scopes: z.array(z.string().max(256)).max(64),
  subscriptionType: z
    .string()
    .max(256)
    .nullish()
    .transform((value) => value ?? undefined),
  rateLimitTier: z
    .string()
    .max(256)
    .nullish()
    .transform((value) => value ?? undefined)
})
const schema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional()
    })
    .passthrough()
    .optional()
})
export function parseClaudeOAuthCredentialsJson(
  raw: string,
  source: ClaudeOAuthCredentialSource,
  includeNativeAccess = false
): ClaudeOAuthCredentialReadResult {
  try {
    const oauth = schema.parse(JSON.parse(raw)).claudeAiOauth
    // Why: expiresAt is not authoritative for the usage endpoint; let the server decide.
    const nativeAccess = includeNativeAccess ? nativeAccessSchema.safeParse(oauth) : null
    return {
      token: oauth?.accessToken || null,
      hasRefreshableCredentials: Boolean(oauth?.refreshToken),
      source,
      ...(nativeAccess?.success ? { nativeAccess: nativeAccess.data } : {})
    }
  } catch {
    return { ...emptyClaudeOAuthCredentialReadResult(), unavailable: true }
  }
}
export function emptyClaudeOAuthCredentialReadResult(): ClaudeOAuthCredentialReadResult {
  return { token: null, hasRefreshableCredentials: false, source: 'none' }
}
export async function readClaudeCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: ClaudeOAuthCredentialSource,
  includeNativeAccess = false
): Promise<ClaudeOAuthCredentialReadResult> {
  try {
    const contents = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return contents
      ? parseClaudeOAuthCredentialsJson(contents, source, includeNativeAccess)
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return {
      ...emptyClaudeOAuthCredentialReadResult(),
      unavailable: true,
      keychainUnavailable: true
    }
  }
}
async function readClaudeKeychainCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  if (!options?.keychainConfigDir) {
    return readClaudeCredentialsFromStrictKeychain(
      undefined,
      'legacy-keychain',
      options?.includeNativeAccess
    )
  }
  const scoped = await readClaudeCredentialsFromStrictKeychain(
    options.keychainConfigDir,
    'scoped-keychain',
    options.includeNativeAccess
  )
  if (scoped.token || !options.unsuffixedKeychainFallback) {
    return scoped
  }
  const legacy = await readClaudeCredentialsFromStrictKeychain(
    undefined,
    'legacy-keychain',
    options.includeNativeAccess
  )
  // Why: as before profiles, a token wins over an unreadable item.
  const candidates = [scoped, legacy]
  return (
    candidates.find((candidate) => candidate.token) ??
    candidates.find((candidate) => candidate.unavailable) ??
    legacy
  )
}
export async function readClaudeOAuthCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  const keychain =
    process.platform === 'darwin'
      ? await readClaudeKeychainCredentials(options)
      : emptyClaudeOAuthCredentialReadResult()
  if (keychain.token) {
    return keychain
  }
  if (options?.includeNativeAccess && keychain.unavailable) {
    return keychain
  }
  try {
    return parseClaudeOAuthCredentialsJson(
      await readFile(
        path.join(
          options?.credentialsFileConfigDir ?? path.join(homedir(), '.claude'),
          '.credentials.json'
        ),
        'utf8'
      ),
      'credentials-file',
      options?.includeNativeAccess
    )
  } catch (error) {
    return isDefinitiveAbsence(error) ? keychain : { ...keychain, unavailable: true }
  }
}
export function resolveClaudeOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): ClaudeOAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  const accountDir = authPreparation.envPatch.CLAUDE_CONFIG_DIR
  return {
    credentialsFileConfigDir: authPreparation.configDir,
    // Why the user's own folder, login shell first: Claude names System default's item from it.
    keychainConfigDir:
      accountDir ??
      getClaudeProfileRouter()?.userConfigDir() ??
      readUserClaudeConfigDir(process.env),
    // An unsuffixed lookup is exclusively System default, never a fallback from an account.
    unsuffixedKeychainFallback: !accountDir
  }
}
