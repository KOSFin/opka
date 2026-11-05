import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { CLAUDE_MANAGED_OAUTH_ENV_VARS } from '../../shared/claude-auth-environment'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  readBoundedClaudeProfileJson,
  type ClaudeNativeAccessSnapshot
} from './claude-native-access'
import { createClaudeNativeFacadePublication } from './claude-native-facade-publication'
import {
  claudeProfileMarkerPath,
  describeClaudeProfile,
  prepareClaudeProfileDirectory,
  type ClaudeProfileTarget
} from './claude-profile-paths'
import { provisionClaudeProfileSurfaces } from './claude-profile-setup'
import type { readActiveClaudeKeychainCredentialsStrict } from './keychain'
import { openClaudeNativePreferences } from './claude-native-preferences'
import { createClaudeNativeKeychainGuard } from './claude-native-keychain-guard'
import { createClaudeNativeFacadePreparation } from './claude-native-facade-preparation'

const SESSION_LIMIT = 128
const authKeys = new Set<string>(CLAUDE_MANAGED_OAUTH_ENV_VARS)

export function claudeNativeFacadeSettings(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const { apiKeyHelper: _authHelper, env, ...rest } = settings
  const parsed = z.record(z.string(), z.unknown()).safeParse(env)
  return {
    ...rest,
    ...(parsed.success
      ? {
          env: Object.fromEntries(Object.entries(parsed.data).filter(([key]) => !authKeys.has(key)))
        }
      : {})
  }
}

/** Disposable config/auth facade; the existing profile provisioner owns native shared surfaces. */
export async function createClaudeNativeAccessFacade(args: {
  dataRoot: string
  sessionId: string
  target: ClaudeProfileTarget
  userHome: string
  userConfigDir?: string
  snapshot: ClaudeNativeAccessSnapshot
  assertExclusive: () => void
  platform?: NodeJS.Platform
  readScopedKeychain?: typeof readActiveClaudeKeychainCredentialsStrict
  projectSettings?: (settings: Record<string, unknown>) => Record<string, unknown>
}) {
  args.assertExclusive()
  z.uuid().parse(args.sessionId)
  const root = join(args.dataRoot, 'native-cli-sessions')
  const profile = describeClaudeProfile(root, args.sessionId, args.target)
  const namespace = join(root, 'claude-profiles')
  if (
    existsSync(namespace) &&
    readdirSync(namespace).length >= SESSION_LIMIT &&
    !existsSync(profile.home)
  ) {
    throw new Error(
      'Claude native session profile limit reached; retained profiles require review.'
    )
  }
  const preparation = createClaudeNativeFacadePreparation(
    dirname(profile.home),
    args.assertExclusive
  )
  try {
    const finish = prepareClaudeProfileDirectory(root, profile, args.userHome, args.userConfigDir)
    if (!existsSync(claudeProfileMarkerPath(profile))) {
      const report = await provisionClaudeProfileSurfaces({
        profileHome: profile.home,
        userHome: args.userHome,
        userConfigDir: args.userConfigDir
      })
      if (report.warnings.length > 0) {
        throw new Error('Claude native profile features could not be prepared completely.')
      }
      const statePath = join(profile.home, '.claude.json')
      if (!existsSync(statePath)) {
        writeFileAtomically(statePath, '{}', { mode: 0o600 })
      }
      const settingsPath = join(profile.home, 'settings.json')
      const settings = existsSync(settingsPath) ? readBoundedClaudeProfileJson(settingsPath) : {}
      writeFileAtomically(settingsPath, JSON.stringify(claudeNativeFacadeSettings(settings)), {
        mode: 0o600
      })
      finish()
    }
    const markerPath = claudeProfileMarkerPath(profile)
    const marker = readFileSync(markerPath, 'utf8')
    const assertNoNativeKeychainLogin = createClaudeNativeKeychainGuard({
      home: profile.home,
      platform: args.platform,
      readScopedKeychain: args.readScopedKeychain,
      assertExclusive: args.assertExclusive
    })
    await assertNoNativeKeychainLogin()
    preparation.checkpoint()
    const publication = createClaudeNativeFacadePublication(profile.home, args.snapshot)
    const preferences = openClaudeNativePreferences({
      dataRoot: args.dataRoot,
      home: profile.home,
      assertExclusive: args.assertExclusive,
      projectSettings: (settings) =>
        claudeNativeFacadeSettings(args.projectSettings?.(settings) ?? settings)
    })
    publication.initialize()
    let authenticationSettingsChanged = false
    const assertAuthenticationSettings = () => {
      const file = join(profile.home, 'settings.json')
      const settings = readBoundedClaudeProfileJson(file)
      const env = z.record(z.string(), z.unknown()).safeParse(settings.env ?? {})
      if (
        authenticationSettingsChanged ||
        Object.hasOwn(settings, 'apiKeyHelper') ||
        !env.success ||
        Object.keys(env.data).some((key) => authKeys.has(key))
      ) {
        authenticationSettingsChanged = true
        throw new Error(
          'Claude native authentication settings changed; automatic switching is suspended.'
        )
      }
    }
    assertAuthenticationSettings()
    return {
      home: profile.home,
      async assertAccessCurrent(): Promise<void> {
        args.assertExclusive()
        await assertNoNativeKeychainLogin()
        assertAuthenticationSettings()
        publication.assertUnchanged()
      },
      async publish(snapshot: ClaudeNativeAccessSnapshot, canSwitch: () => boolean): Promise<void> {
        args.assertExclusive()
        await assertNoNativeKeychainLogin()
        assertAuthenticationSettings()
        publication.publish(snapshot, canSwitch)
      },
      async recover(): Promise<void> {
        await assertNoNativeKeychainLogin()
        publication.recover()
      },
      async dispose(): Promise<void> {
        args.assertExclusive()
        await assertNoNativeKeychainLogin()
        assertAuthenticationSettings()
        publication.assertUnchanged()
        if (readFileSync(markerPath, 'utf8') !== marker) {
          throw new Error('Claude native session ownership changed.')
        }
        preferences.save()
        args.assertExclusive()
        rmSync(dirname(profile.home), { recursive: true })
      }
    }
  } catch (error) {
    preparation.rollback()
    throw error
  }
}
