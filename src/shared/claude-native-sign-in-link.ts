export const CLAUDE_NATIVE_AUTHORIZE_HOSTS: ReadonlySet<string> = new Set([
  'claude.com',
  'claude.ai',
  'platform.claude.com'
])

/** The qualified native2.1.318 manual-code flow, never a remote user's localhost callback. */
export function isClaudeHostedNativeSignInLink(value: string): boolean {
  try {
    const url = new URL(value)
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
    return (
      url.protocol === 'https:' &&
      url.hostname === 'platform.claude.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/oauth/authorize' &&
      redirect.origin === 'https://platform.claude.com' &&
      redirect.pathname === '/oauth/code/callback' &&
      Boolean(url.searchParams.get('state') && url.searchParams.get('code_challenge'))
    )
  } catch {
    return false
  }
}
