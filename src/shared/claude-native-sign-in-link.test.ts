import { expect, it } from 'vitest'
import { isClaudeHostedNativeSignInLink } from './claude-native-sign-in-link'
import { NativeClaudeRefreshSignInLinkResult } from './native-claude-refresh-source'

const link =
  'https://platform.claude.com/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=fake&code_challenge=fake'
it('accepts the exact pinned native hosted code flow', () => {
  expect(isClaudeHostedNativeSignInLink(link)).toBe(true)
  expect(
    NativeClaudeRefreshSignInLinkResult.parse({ link, state: 'signing-in', requiresCode: true })
      .link
  ).toBe(link)
})
it.each([
  link.replace(
    'https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback',
    'http%3A%2F%2Flocalhost%3A1234%2Fcallback'
  ),
  link.replace('https://platform.claude.com/', 'https://untrusted.invalid/'),
  link.replace('https://platform.claude.com/', 'https://user:secret@platform.claude.com/'),
  link.replace('code_challenge=fake', 'missing=fake')
])('rejects callback, foreign, credential-bearing and incomplete URLs', (value) => {
  expect(isClaudeHostedNativeSignInLink(value)).toBe(false)
  expect(
    NativeClaudeRefreshSignInLinkResult.safeParse({ link: value, state: 'signing-in' }).success
  ).toBe(false)
})
