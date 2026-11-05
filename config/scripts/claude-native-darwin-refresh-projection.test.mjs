import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDarwinRefreshFailureProjection } from './claude-native-darwin-refresh-projection.mjs'

test('failed-guard source projection contains only fixed fields and no credential values/keys', async () => {
  const identity = {
    accountUuid: 'fake-account',
    organizationUuid: 'fake-org',
    emailAddress: 'fake@example.invalid'
  }
  const result = await readDarwinRefreshFailureProjection({
    config: '/fake-owned',
    identity,
    freshAccess: 'fake-fresh',
    rotatedRefresh: 'fake-rotated',
    api: {
      readClaudeOAuthCredentials: async () => ({
        source: 'scoped-keychain',
        nativeAccess: { accessToken: 'fake-fresh', expiresAt: Date.now() + 60000 }
      }),
      readBoundedClaudeProfileJson: (path) =>
        path.endsWith('.credentials.json')
          ? {
              claudeAiOauth: {
                accessToken: 'adversarial-secret',
                refreshToken: 'private-refresh',
                privateUnexpectedKey: 'secret'
              }
            }
          : { oauthAccount: identity }
    }
  })
  assert.equal(result.observation.source, 'scoped-keychain')
  assert.equal(result.observation.freshAccessMatched, true)
  assert.equal(result.profileObservation.accountMatched, true)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(Object.hasOwn(result.fileObservation, 'fieldNames'), false)
})
