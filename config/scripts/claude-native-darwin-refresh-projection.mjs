import { join } from 'node:path'

/** Fixed, secret-free projection of the actual source selected after a failed guard. */
export async function readDarwinRefreshFailureProjection({
  api,
  config,
  identity,
  freshAccess,
  rotatedRefresh
}) {
  const observation = await api
    .readClaudeOAuthCredentials({
      credentialsFileConfigDir: config,
      keychainConfigDir: config,
      includeNativeAccess: true
    })
    .then(
      (value) => ({
        source: value.source,
        unavailable: value.unavailable === true,
        nativeAccessKnown: Boolean(value.nativeAccess),
        freshAccessMatched: value.nativeAccess?.accessToken === freshAccess,
        expiryFresh: (value.nativeAccess?.expiresAt ?? 0) > Date.now() + 30000
      }),
      () => ({ unavailable: true })
    )
  let fileObservation = { readable: false }
  try {
    const access = api.readBoundedClaudeProfileJson(join(config, '.credentials.json')).claudeAiOauth
    fileObservation = {
      readable: true,
      freshAccessMatched: access?.accessToken === freshAccess,
      refreshRotated: access?.refreshToken === rotatedRefresh,
      accessFieldKnown: typeof access?.accessToken === 'string',
      refreshFieldKnown: typeof access?.refreshToken === 'string'
    }
  } catch {}
  let profileObservation = { readable: false }
  try {
    const profile = api.readBoundedClaudeProfileJson(join(config, '.claude.json')).oauthAccount
    profileObservation = {
      readable: true,
      accountMatched: profile?.accountUuid === identity.accountUuid,
      organizationMatched: profile?.organizationUuid === identity.organizationUuid,
      emailMatched: profile?.emailAddress === identity.emailAddress
    }
  } catch {}
  return { observation, fileObservation, profileObservation }
}
