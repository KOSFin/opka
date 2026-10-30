import { expect, it, vi } from 'vitest'
import type { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { resolvePinnedClaudeStructuredLaunchHome } from './claude-structured-launch-home'
it('keeps pooled credentials and shell route independent from the global selected account', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This pure routing branch reads only accountHome/accountLogin; global prepare is a sentinel.
  const router = {
    accountHome: () => '/pool/home',
    accountLogin: () => ({ email: 'synthetic@example.test' }),
    prepareLaunch: vi.fn()
  } as unknown as ClaudeProfileRouter
  const env = {
    ANTHROPIC_API_KEY: 'synthetic-secret',
    CLAUDE_CONFIG_DIR: '/global/home',
    ORCA_CLAUDE_PROFILE_POINTER: '/global/pointer'
  }
  expect(resolvePinnedClaudeStructuredLaunchHome(router, env, '/pool/home', 'a')).toBe('/pool/home')
  expect(env.CLAUDE_CONFIG_DIR).toBe('/pool/home')
  expect(env.ORCA_CLAUDE_PROFILE_POINTER).toBe('/pool/pinned-launch-home')
  expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
  expect(router.prepareLaunch).not.toHaveBeenCalled()
})
it('refuses a mismatched profile rather than silently selecting another account', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only accountHome is read before this mismatch refuses.
  const router = { accountHome: () => '/other/home' } as unknown as ClaudeProfileRouter
  expect(() => resolvePinnedClaudeStructuredLaunchHome(router, {}, '/pool/home', 'a')).toThrow(
    'needs sign-in'
  )
})
