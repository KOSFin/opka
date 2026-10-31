import type { CodexDeviceAuthorization } from '../../shared/account-device-sign-in'
import { stripVTControlCharacters } from 'node:util'

/** Matches the captured Codex 0.160.0 device-auth prompt, including split ANSI output. */
export function parseCodexDeviceAuthorization(output: string): CodexDeviceAuthorization | null {
  const text = stripVTControlCharacters(output)
  if (!text.includes('https://auth.openai.com/codex/device')) {
    return null
  }
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{5})(?:\s|$)/.exec(text)?.[1]
  return code ? { verificationUrl: 'https://auth.openai.com/codex/device', userCode: code } : null
}

export function codexDeviceSignInFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : ''
  if (/cancelled/i.test(text)) {
    return 'Codex sign-in was cancelled.'
  }
  if (/too long|timed out/i.test(text)) {
    return 'Codex sign-in expired. Start a new sign-in.'
  }
  if (/403|forbidden/i.test(text)) {
    return 'OpenAI rejected sign-in (403). Check this server’s outbound connection and account access.'
  }
  if (/not found|node.js/i.test(text)) {
    return 'Codex CLI could not start on this server. Check its installation.'
  }
  return 'Codex sign-in failed. Check this server’s connection and try again.'
}
