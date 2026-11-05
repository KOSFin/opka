import { z } from 'zod'
import type { CodexManagedAccount } from '../../shared/managed-account-types'

export type CodexEngineAccountConnection = {
  kind: 'engine-owned-device-oauth'
  accountId: string
  providerAccountId: string
  engineCredentialId: string
  prefix: string
}

export function engineCredentialFilename(accountId: string): string {
  return `opka-${z.uuid().parse(accountId).toLowerCase()}.json`
}

/** This projection must come from a fresh engine grant on the execution host, never the client. */
export function verifyEngineAccountConnection(
  account: Pick<CodexManagedAccount, 'id' | 'providerAccountId'>,
  engine: {
    provider: string
    credentialId: string
    providerAccountId: string | null
    prefix?: string
  }
): CodexEngineAccountConnection {
  const accountId = z.uuid().parse(account.id)
  const expectedIdentity = account.providerAccountId?.trim()
  if (!expectedIdentity || !engine.providerAccountId?.trim()) {
    throw new Error('A confirmed provider account identity is required to connect routing.')
  }
  if (engine.provider !== 'codex' || expectedIdentity !== engine.providerAccountId.trim()) {
    throw new Error('The routing sign-in belongs to a different provider account.')
  }
  if (
    !engine.credentialId ||
    engine.credentialId.length > 512 ||
    /[<>:"|?*/\\]/.test(engine.credentialId) ||
    [...engine.credentialId].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(engine.credentialId) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(engine.credentialId) ||
    engine.credentialId === '.' ||
    engine.credentialId === '..'
  ) {
    throw new Error('An engine-owned credential filename is required.')
  }
  const prefix = `opka-codex-${accountId.replaceAll('-', '').toLowerCase()}`
  if (engine.prefix && engine.prefix !== prefix) {
    throw new Error('This routing credential already belongs to another account connection.')
  }
  return {
    kind: 'engine-owned-device-oauth',
    accountId,
    providerAccountId: expectedIdentity,
    engineCredentialId: engine.credentialId,
    prefix
  }
}
