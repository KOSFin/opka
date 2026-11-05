import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  assertClaudeProfileDescendant,
  claudeProfileMarkerPath,
  describeClaudeProfile
} from './claude-profile-paths'
import { ClaudeNativeIdentity, readBoundedClaudeProfileJson } from './claude-native-access'
import { isSameClaudeLogin } from './claude-account-folder'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'

/** Files alone never prove that a retained native CLI stopped after its owning host restarted. */
export function assertNoUnverifiableClaudeFacades(
  dataRoot: string,
  account: ClaudeManagedAccountSummary
): void {
  const root = join(dataRoot, 'native-cli-sessions'),
    namespace = join(root, 'claude-profiles')
  assertClaudeProfileDescendant(dataRoot, namespace)
  if (!existsSync(namespace)) {
    return
  }
  const sessions = readdirSync(namespace)
  if (sessions.length > 128) {
    throw new Error('Claude native session inventory requires review.')
  }
  for (const session of sessions) {
    const profile = describeClaudeProfile(root, z.uuid().parse(session), {
      executionHostId: 'local',
      runtime: 'host'
    })
    assertClaudeProfileDescendant(root, profile.home)
    const marker = readBoundedClaudeProfileJson(claudeProfileMarkerPath(profile))
    if (marker.version !== 1 || marker.accountId !== session || marker.runtime !== 'host') {
      throw new Error('Claude native session ownership is unverifiable.')
    }
    const identity = ClaudeNativeIdentity.parse(
      readBoundedClaudeProfileJson(join(profile.home, '.claude.json')).oauthAccount
    )
    if (
      isSameClaudeLogin(
        { email: account.email, organizationUuid: account.organizationUuid },
        { email: identity.emailAddress, organizationUuid: identity.organizationUuid }
      )
    ) {
      throw new Error(
        'A retained native Claude session is unverifiable. Close or recover that session before removing this account.'
      )
    }
  }
}
