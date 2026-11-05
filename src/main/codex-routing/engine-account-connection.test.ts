import { expect, it } from 'vitest'
import { verifyEngineAccountConnection } from './engine-account-connection'
import { parseEngineDeviceAuthorization } from './engine-device-authorization'

const account = {
  id: '10000000-0000-4000-8000-000000000001',
  providerAccountId: 'provider-account-A'
}
const grant = {
  provider: 'codex',
  credentialId: 'fresh-engine-grant.json',
  providerAccountId: 'provider-account-A'
}

it('links fresh engine identity to the existing roster ID with a stable unique prefix', () => {
  const first = verifyEngineAccountConnection(account, grant)
  expect(first).toEqual({
    kind: 'engine-owned-device-oauth',
    accountId: account.id,
    providerAccountId: account.providerAccountId,
    engineCredentialId: grant.credentialId,
    prefix: 'opka-codex-10000000000040008000000000000001'
  })
  expect(verifyEngineAccountConnection(account, { ...grant, prefix: first.prefix })).toEqual(first)
  expect(
    verifyEngineAccountConnection({ ...account, id: '10000000-0000-4000-8000-000000000002' }, grant)
      .prefix
  ).not.toBe(first.prefix)
})

it('refuses missing or mismatched strong identity even when a display email might agree', () => {
  expect(() =>
    verifyEngineAccountConnection({ ...account, providerAccountId: null }, grant)
  ).toThrow(/confirmed provider/)
  expect(() =>
    verifyEngineAccountConnection(account, { ...grant, providerAccountId: null })
  ).toThrow(/confirmed provider/)
  expect(() =>
    verifyEngineAccountConnection(account, { ...grant, providerAccountId: 'provider-account-B' })
  ).toThrow(/different provider/)
  expect(() =>
    verifyEngineAccountConnection(account, { ...grant, providerAccountId: 'provider-account-a' })
  ).toThrow(/different provider/)
  expect(() => verifyEngineAccountConnection(account, { ...grant, provider: 'claude' })).toThrow(
    /different provider/
  )
})

it('refuses a credential owned by another connection and unsafe filenames', () => {
  expect(() =>
    verifyEngineAccountConnection(account, { ...grant, prefix: 'another-account' })
  ).toThrow(/already belongs/)
  for (const credentialId of [
    '../auth.json',
    'C:\\auth.json',
    'C:auth.json',
    'grant.json:token',
    'CON.json',
    'grant.json.',
    'grant.json ',
    '..',
    'bad\nname',
    ''
  ]) {
    expect(() => verifyEngineAccountConnection(account, { ...grant, credentialId })).toThrow(
      /filename/
    )
  }
})

it('reads only the pinned engine device labels and never returns unrelated output', () => {
  const result = parseEngineDeviceAuthorization(
    '\u001b[32mCodex device URL: https://auth.openai.com/codex/device\u001b[0m\nCodex device code: ABCD-12345\nprivate-output-not-forwarded'
  )
  expect(result).toEqual({
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-12345'
  })
  expect(JSON.stringify(result)).not.toContain('private-output')
})

it('does not trust unrelated URLs, truncated codes, native CLI prose or oversized old prompts', () => {
  for (const output of [
    'Codex device URL: https://attacker.invalid/codex/device\nCodex device code: ABCD-12345',
    'Codex device URL: https://auth.openai.com/codex/device\nCodex device code: ABCD-1234',
    'https://auth.openai.com/codex/device\none-time code\nABCD-12345',
    `Codex device URL: https://auth.openai.com/codex/device\nCodex device code: ABCD-12345\n${'x'.repeat(4001)}`
  ]) {
    expect(parseEngineDeviceAuthorization(output)).toBeNull()
  }
})
