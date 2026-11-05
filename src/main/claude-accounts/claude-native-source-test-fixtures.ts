import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { runClaudeNativeSourceLogin } from './claude-native-source-login'
import { ClaudeNativeSourceAttestation } from './claude-native-source-profile'

export function nativeSourceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-source-'))
  const dataRoot = join(root, 'data')
  const userHome = join(root, 'user')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  const legacy = join(userHome, '.claude', '.credentials.json')
  writeFileSync(legacy, 'synthetic legacy source must remain untouched')
  const account: ClaudeManagedAccountSummary = {
    id: 'existing-account',
    email: 'synthetic@example.invalid',
    organizationUuid: 'org-A',
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const identity = {
    accountUuid: 'account-A',
    organizationUuid: 'org-A',
    emailAddress: account.email
  }
  let queue: Promise<unknown> = Promise.resolve()
  let exclusive = true
  const accounts = {
    listAccounts: () => ({
      accounts: [account],
      activeAccountId: account.id,
      systemDefaultMayBeCopied: true
    }),
    withNativeRoutingMutation<T>(operation: () => Promise<T>): Promise<T> {
      const next = queue.then(operation, operation)
      queue = next.catch(() => {})
      return next
    }
  }
  const writeLogin = (home: string, email = account.email) => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { ...identity, emailAddress: email } }),
      { mode: 0o600 }
    )
    writeFileSync(
      join(home, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'synthetic-new-access',
          refreshToken: 'synthetic-new-refresh',
          expiresAt: Date.now() + 3600_000,
          scopes: ['user:inference', 'user:profile']
        }
      }),
      { mode: 0o600 }
    )
  }
  const login = vi.fn<typeof runClaudeNativeSourceLogin>(async ({ home }) => {
    writeLogin(home)
  })
  const options = {
    dataRoot,
    userHome,
    accounts,
    machineIdentity: () => 'synthetic-machine',
    platformQualified: () => true,
    assertExclusiveProfile: () => {
      if (!exclusive) {
        throw new Error('profile ownership changed')
      }
    },
    resolveLaunch: async () => ({ command: '/synthetic/claude', args: [], version: '2.1.318' }),
    login
  }
  const sourceRoot = join(dataRoot, 'claude-native-refresh-sources', account.id)
  const attestation = () =>
    ClaudeNativeSourceAttestation.parse(
      JSON.parse(readFileSync(join(sourceRoot, 'active-source.json'), 'utf8'))
    )
  return {
    root,
    options,
    account,
    identity,
    sourceRoot,
    legacy,
    login,
    writeLogin,
    attestation,
    loseProfile: () => {
      exclusive = false
    }
  }
}
