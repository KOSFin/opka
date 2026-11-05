import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createRuntimeCodexQuotaFailureRecorder,
  type NativeCodexQuotaSettings
} from './runtime-codex-quota-failure'
import type {
  CodexProviderFailureAccountResolver,
  CodexProviderFailureEvent
} from '../rate-limits/codex-provider-failure'

function fixture() {
  const settings: NativeCodexQuotaSettings = {
    activeCodexManagedAccountId: 'a',
    codexManagedAccounts: [
      {
        id: 'a',
        email: 'synthetic@example.test',
        providerAccountId: 'provider-a',
        managedHomePath: join(tmpdir(), 'synthetic-codex-home'),
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ]
  }
  const readConnection = vi.fn((): { providerAccountId: string } | null => ({
    providerAccountId: 'provider-a'
  }))
  const ingest = vi.fn(
    (_event: CodexProviderFailureEvent, _resolver: CodexProviderFailureAccountResolver) => true
  )
  let retained: CodexProviderFailureAccountResolver | undefined
  const record = createRuntimeCodexQuotaFailureRecorder({
    getSettings: () => settings,
    readConnection,
    rateLimits: {
      ingestCodexProviderFailure: (event, resolver) => {
        retained = resolver
        return ingest(event, resolver)
      }
    }
  })
  const event = {
    accountId: 'a',
    quotaIdentity: 'provider-a',
    code: 'usage_limit_reached' as const
  }
  return { settings, readConnection, ingest, record, event, resolver: () => retained }
}

it('stamps a verified host rejection with current host provenance, never an invented window', () => {
  const f = fixture()
  expect(f.record(f.event)).toBe(true)
  expect(f.ingest).toHaveBeenCalledWith(
    expect.objectContaining({
      ...f.event,
      authProvenance: 'profile:a',
      observedAt: expect.any(Number)
    }),
    expect.any(Function)
  )
  expect(f.ingest.mock.calls[0]?.[0]).not.toHaveProperty('usedPercent')
  expect(f.readConnection).toHaveBeenCalledTimes(1)
})

it('retains a fresh metadata-only resolver without quota state recursion or repeated auth reads', () => {
  const f = fixture()
  f.record(f.event)
  const resolver = f.resolver()
  expect(resolver?.('a')).toMatchObject({ quotaIdentity: 'provider-a', selected: true })
  f.settings.codexManagedAccounts = []
  expect(resolver?.('a')).toBeNull()
  expect(f.readConnection).toHaveBeenCalledTimes(1)
})

it('uses the host lane even when another runtime lane is selected in the interface', () => {
  const f = fixture()
  f.settings.activeCodexManagedAccountId = 'wsl-b'
  f.settings.activeCodexManagedAccountIdsByRuntime = { host: 'a', wsl: { ubuntu: 'wsl-b' } }
  f.record(f.event)
  expect(f.resolver()?.('a')?.selected).toBe(true)
})

it.each(['missing', 'different'] as const)('refuses %s engine connection identity', (kind) => {
  const f = fixture()
  f.readConnection.mockReturnValue(kind === 'missing' ? null : { providerAccountId: 'provider-b' })
  expect(f.record(f.event)).toBe(false)
  expect(f.ingest).not.toHaveBeenCalled()
})

it('never attributes failure to an email-only identity, removed account or WSL account', () => {
  const f = fixture()
  const account = f.settings.codexManagedAccounts?.[0]
  if (!account) {
    throw new Error('Missing fixture account')
  }
  account.providerAccountId = null
  expect(f.record(f.event)).toBe(false)
  account.providerAccountId = 'provider-a'
  account.managedHomeRuntime = 'wsl'
  expect(f.record(f.event)).toBe(false)
  f.settings.codexManagedAccounts = []
  expect(f.record(f.event)).toBe(false)
  expect(f.ingest).not.toHaveBeenCalled()
})
