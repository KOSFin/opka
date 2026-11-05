import { stripVTControlCharacters } from 'node:util'
import type { CodexDeviceAuthorization } from '../../shared/account-device-sign-in'

/** The pinned engine prints its own labels rather than the native Codex prompt. */
export function parseEngineDeviceAuthorization(output: string): CodexDeviceAuthorization | null {
  const text = stripVTControlCharacters(output.slice(-4000))
  if (!/^Codex device URL: https:\/\/auth\.openai\.com\/codex\/device\s*$/m.test(text)) {
    return null
  }
  const userCode = /^Codex device code: ([A-Z0-9]{4}-[A-Z0-9]{5})\s*$/m.exec(text)?.[1]
  return userCode ? { verificationUrl: 'https://auth.openai.com/codex/device', userCode } : null
}
