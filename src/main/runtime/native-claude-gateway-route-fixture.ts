import { expect, vi } from 'vitest'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import { createNativeClaudeGatewayRouteSession } from './native-claude-gateway-route-session'

export function fixture() {
  let policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'claude',
    revision: 1,
    strategy: 'balanced',
    applyToNewWork: true,
    rotation: 'on-limit',
    unknownQuota: 'allow',
    allowReserve: false,
    members: ['A', 'B', 'C'].map((accountId) => ({
      accountId,
      priority: 1,
      weight: 1,
      state: 'enabled',
      role: 'primary',
      maxConcurrent: 1
    }))
  }
  let current = true,
    quiet = true,
    owner = 'owned-native',
    counter = 0,
    releaseFailure = false
  let pool = true,
    manual: string | null = null,
    input = 0,
    idle = true,
    preferred: string | undefined
  const acceptedBoundary = vi.fn(() => {
    idle = false
  })
  const boundary = () => ({ canSwitch: () => idle, onBoundaryAccepted: acceptedBoundary })
  const active = new Set(['initial-A'])
  const release = vi.fn((key: string) => {
    if (releaseFailure) {
      throw new Error('Synthetic release failure')
    }
    active.delete(key)
  })
  const candidates = ['A', 'B', 'C'].map((accountId) => ({
    accountId,
    quotaIdentity: `quota-${accountId}`,
    auth: 'ready' as const,
    quota: 'available' as const,
    usedPercent: 0
  }))
  const refresh = vi.fn(async (accountId: string) => ({
    access: {
      accessToken: `synthetic-${accountId}`,
      expiresAt: 4_000_000_000_000,
      scopes: ['user:inference']
    },
    identity: {
      accountUuid: accountId,
      organizationUuid: `org-${accountId}`,
      emailAddress: `${accountId}@example.invalid`
    }
  }))
  const selected = vi.fn<(selection: { accountId: string; ownerKey?: string }) => void>()
  const session = createNativeClaudeGatewayRouteSession({
    launchId: 'synthetic-launch',
    initialAccountId: 'A',
    initialOwnerKey: 'initial-A',
    db: {
      acquireAccountPoolAssignment: () => {
        throw new Error('Use shared admission')
      },
      releaseAccountPoolAssignment: release
    },
    acquireAssignment: (admission) => {
      expect(active.size).toBeLessThan(2)
      const candidate =
        admission.candidates.find((entry) => entry.accountId === preferred) ??
        admission.candidates[0]
      if (!candidate) {
        throw new Error('No candidate')
      }
      const ownerKey = `pending-${++counter}`
      active.add(ownerKey)
      return {
        ownerKey,
        accountId: candidate.accountId,
        quotaIdentity: candidate.quotaIdentity,
        selectionReason: null,
        provider: 'claude',
        poolId: policy.id,
        policyRevision: policy.revision,
        sequence: counter,
        releasedAt: null,
        ptyId: null,
        incarnationId: null
      }
    },
    sources: {
      assertOwned: () => {},
      assertAccountOwned: () => {},
      refresh,
      readyAccountIds: async () => new Set(['A', 'B', 'C'])
    },
    readPolicy: () => (pool ? policy : undefined),
    readManualAccountId: () => manual,
    readIdleBoundary: boundary,
    readBoundary: boundary,
    readInputVersion: () => input,
    readCandidates: () => candidates,
    readOwner: () => ({ identity: owner, sessionId: 'native-root' }),
    isCurrent: () => current,
    canReplace: () => quiet,
    onAccountSelected: selected
  })
  return {
    session,
    active,
    release,
    refresh,
    selected,
    candidates,
    boundary,
    acceptedBoundary,
    prefer: (id: string) => {
      preferred = id
    },
    idle: (value: boolean) => {
      idle = value
    },
    changeInput: () => {
      input++
    },
    manual: (id: string | null) => {
      manual = id
    },
    removePolicy: () => {
      pool = false
    },
    rotation: (rotation: AccountPoolPolicy['rotation']) => {
      policy = { ...policy, rotation, revision: policy.revision + 1 }
    },
    save: () => {
      policy = { ...policy, revision: policy.revision + 1 }
    },
    stopApplyingToNew: () => {
      policy = { ...policy, revision: policy.revision + 1, applyToNewWork: false }
    },
    revoke: () => {
      current = false
    },
    changeOwner: () => {
      owner = 'other-native'
    },
    setQuiet: (value: boolean) => {
      quiet = value
    },
    failRelease: (value: boolean) => {
      releaseFailure = value
    }
  }
}
export const signal = () => new AbortController().signal
export const replacement = async (f: ReturnType<typeof fixture>) => {
  const route = await f.session.prepareReplacement(new Set(['quota-A']), signal())
  if (!route) {
    throw new Error('Missing replacement')
  }
  return route
}
