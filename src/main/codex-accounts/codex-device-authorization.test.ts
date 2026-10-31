import { describe, expect, it } from 'vitest'
import {
  codexDeviceSignInFailure,
  parseCodexDeviceAuthorization
} from './codex-device-authorization'

// Captured Codex 0.160.0 device prompt; account/code values replaced with synthetic ones.
const transcript =
  '\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94mAB12-CDE34\x1b[0m\r\n'

describe('Codex device authorization prompt', () => {
  it('recognizes the captured ANSI prompt only when its code is complete', () => {
    expect(
      parseCodexDeviceAuthorization(transcript.slice(0, transcript.indexOf('AB12-CDE34') + 7))
    ).toBeNull()
    expect(parseCodexDeviceAuthorization(transcript)).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'AB12-CDE34'
    })
  })
  it('refuses other provider URLs or text without the device instruction', () => {
    expect(
      parseCodexDeviceAuthorization(
        transcript.replace('https://auth.openai.com/codex/device', 'https://example.com/device')
      )
    ).toBeNull()
    expect(
      parseCodexDeviceAuthorization('https://auth.openai.com/codex/device\nAB12-CDE34')
    ).toBeNull()
  })
  it('never returns provider output, device codes or tokens as error detail', () => {
    const error = codexDeviceSignInFailure(new Error(`${transcript}\n403 token=secret`))
    expect(error).toContain('403')
    expect(error).not.toContain('AB12-CDE34')
    expect(error).not.toContain('secret')
  })
})
