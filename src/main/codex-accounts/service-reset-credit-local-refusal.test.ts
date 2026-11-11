import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { RateLimitState } from '../../shared/rate-limit-types'
import { buildCodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import { ProfileStateWriterError } from '../persistence/profile-state/profile-state-writer-errors'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'
import {
  createResetCreditLimits,
  createResetRateLimitState
} from './service-reset-credit-test-fixtures'
import {
  CodexResetCreditScopeRejection,
  CodexResetCreditSourcePreflightRejection
} from './codex-reset-credit-scope-validation'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('releases a fresh known-local source refusal without recording a provider attempt', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-local-refusal')
    const account = {
      id: 'account-local-refusal',
      email: 'local@example.test',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const scope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    const consume = vi
      .fn()
      .mockImplementationOnce(async (options: { preflightProof?: symbol }) => {
        throw new CodexResetCreditSourcePreflightRejection(
          'accountChanged',
          state,
          'The selected Codex account changed before reset.',
          options.preflightProof
        )
      })
      .mockResolvedValueOnce({ outcome: 'reset', state })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      rateLimits as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const firstKey = '18181818-1818-4181-8181-181818181818'

    await expect(service.consumeRateLimitResetCredit(firstKey, scope)).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'accountChanged'
    })
    expect(consume).toHaveBeenCalledOnce()
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
    expect(state.codex?.rateLimitResetCredits?.availableCount).toBe(1)
    expect(service.listAccounts().activeAccountId).toBe(account.id)

    const restarted = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      rateLimits as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const secondKey = '19191919-1919-4191-8191-191919191919'
    await expect(restarted.consumeRateLimitResetCredit(secondKey, scope)).resolves.toMatchObject({
      outcome: 'reset'
    })
    expect(consume).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: secondKey }))
  })

  it('keeps the original pending key when clearing a local refusal cannot flush', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-clear-failed')
    const account = {
      id: 'account-clear-failed',
      email: 'clear-failed@example.test',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const scope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    const persist = store.replaceCodexResetCreditAttemptLedgerAndFlush.getMockImplementation()!
    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation((ledger) => {
      if (ledger.attempts.length === 0) {
        throw new Error('clear disk full')
      }
      return persist(ledger)
    })
    const consume = vi.fn().mockImplementation(async (options: { preflightProof?: symbol }) => {
      throw new CodexResetCreditSourcePreflightRejection(
        'accountChanged',
        state,
        'The selected Codex account changed before reset.',
        options.preflightProof
      )
    })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const key = '23232323-2323-4232-8232-232323232323'

    await expect(service.consumeRateLimitResetCredit(key, scope)).rejects.toThrow('clear disk full')
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])
    const restarted = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    await expect(
      restarted.consumeRateLimitResetCredit('24242424-2424-4242-8242-242424242424', scope)
    ).rejects.toThrow('The selected Codex account changed before reset.')
    expect(consume).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: key }))
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])
  })

  it('fails closed on an indeterminate local-release write and rehydrates the pending key', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-clear-unknown')
    const account = {
      id: 'account-clear-unknown',
      email: 'clear-unknown@example.test',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const scope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    const persist = store.replaceCodexResetCreditAttemptLedgerAndFlush.getMockImplementation()!
    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation((ledger) => {
      if (ledger.attempts.length === 0) {
        throw new ProfileStateWriterError('write-unknown', 'clear outcome unknown', 'indeterminate')
      }
      return persist(ledger)
    })
    const consume = vi.fn().mockImplementation(async (options: { preflightProof?: symbol }) => {
      throw new CodexResetCreditSourcePreflightRejection(
        'accountChanged',
        state,
        'The selected Codex account changed before reset.',
        options.preflightProof
      )
    })
    const rateLimits = {
      ...createRateLimits(),
      getState: vi.fn(() => state),
      consumeCodexRateLimitResetCredit: consume
    }
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      rateLimits as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const key = '25252525-2525-4252-8252-252525252525'

    await expect(service.consumeRateLimitResetCredit(key, scope)).rejects.toThrow(
      'clear outcome unknown'
    )
    await expect(
      service.consumeRateLimitResetCredit('26262626-2626-4262-8262-262626262626', scope)
    ).rejects.toThrow('Codex reset-credit attempt durability is unknown')
    expect(consume).toHaveBeenCalledOnce()
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])

    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation(persist)
    const restarted = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      rateLimits as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    await expect(
      restarted.consumeRateLimitResetCredit('27272727-2727-4272-8272-272727272727', scope)
    ).rejects.toThrow('The selected Codex account changed before reset.')
    expect(consume).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: key }))
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])
  })

  it('rehydrates an empty ledger after an indeterminate acknowledgment of a committed local release', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-clear-ack-lost')
    const account = {
      id: 'account-clear-ack-lost',
      email: 'clear-ack-lost@example.test',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const scope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    const persist = store.replaceCodexResetCreditAttemptLedgerAndFlush.getMockImplementation()!
    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation(async (ledger) => {
      await persist(ledger)
      if (ledger.attempts.length === 0) {
        throw new ProfileStateWriterError(
          'write-unknown',
          'clear acknowledgment lost',
          'indeterminate'
        )
      }
    })
    const localRefusal = vi
      .fn()
      .mockImplementation(async (options: { preflightProof?: symbol }) => {
        throw new CodexResetCreditSourcePreflightRejection(
          'accountChanged',
          state,
          'The selected Codex account changed before reset.',
          options.preflightProof
        )
      })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: localRefusal
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const originalKey = '30303030-3030-4303-8303-303030303030'

    await expect(service.consumeRateLimitResetCredit(originalKey, scope)).rejects.toThrow(
      'clear acknowledgment lost'
    )
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
    await expect(
      service.consumeRateLimitResetCredit('31313131-3131-4313-8313-313131313131', scope)
    ).rejects.toThrow('Codex reset-credit attempt durability is unknown')
    expect(localRefusal).toHaveBeenCalledOnce()

    store.replaceCodexResetCreditAttemptLedgerAndFlush.mockImplementation(persist)
    const consumeAfterRestart = vi.fn().mockResolvedValue({ outcome: 'reset', state })
    const restarted = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consumeAfterRestart
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const confirmedKey = '32323232-3232-4323-8323-323232323232'
    await expect(restarted.consumeRateLimitResetCredit(confirmedKey, scope)).resolves.toMatchObject(
      {
        outcome: 'reset'
      }
    )
    expect(consumeAfterRestart).toHaveBeenCalledOnce()
    expect(consumeAfterRestart).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: confirmedKey })
    )
  })

  it('singleflights two confirmed keys for one offer before a local source refusal', async () => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-local-concurrent')
    const account = {
      id: 'account-local-concurrent',
      email: 'local-concurrent@example.test',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const scope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    const preflight = Promise.withResolvers<void>()
    const consume = vi.fn().mockImplementationOnce(async (options: { preflightProof?: symbol }) => {
      await preflight.promise
      throw new CodexResetCreditSourcePreflightRejection(
        'accountChanged',
        state,
        'The selected Codex account changed before reset.',
        options.preflightProof
      )
    })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const firstKey = '28282828-2828-4282-8282-282828282828'
    const first = service.consumeRateLimitResetCredit(firstKey, scope)
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce())
    const second = service.consumeRateLimitResetCredit(
      '29292929-2929-4292-8292-292929292929',
      scope
    )
    preflight.resolve()

    await expect(first).resolves.toMatchObject({ status: 'rejectedBeforeProvider' })
    await expect(second).resolves.toMatchObject({ status: 'rejectedBeforeProvider' })
    expect(consume).toHaveBeenCalledOnce()
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: firstKey }))
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
  })

  it.each([
    ['HTTP 401', (_state: RateLimitState) => new Error('Codex backend rejected reset: HTTP 401')],
    ['HTTP 403', (_state: RateLimitState) => new Error('Codex backend rejected reset: HTTP 403')],
    ['timeout', (_state: RateLimitState) => new Error('Reset request timed out')],
    [
      'wrong proof',
      (state: RateLimitState) =>
        new CodexResetCreditSourcePreflightRejection(
          'accountChanged',
          state,
          'Unverified preflight error after request.',
          Symbol('wrong-proof')
        )
    ],
    [
      'unproven scope rejection',
      (state: RateLimitState) =>
        new CodexResetCreditScopeRejection(
          'accountChanged',
          state,
          'An after-request scope failure has unknown transport outcome.'
        )
    ]
  ])('keeps an after-request %s pending under its original key', async (_label, failureFor) => {
    const managedHomePath = createManagedHome(testState.userDataDir, 'account-http-403')
    const account = {
      id: 'account-http-403',
      email: 'denied@example.test',
      managedHomePath,
      managedHomeRuntime: 'host' as const,
      wslDistro: null,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    const limits = createResetCreditLimits()
    const state = createResetRateLimitState(limits)
    const scope = buildCodexResetCreditExpectedScope({
      target: state.codexTarget,
      account,
      limits
    })!
    const store = createStore(settings)
    const firstFailure = failureFor(state)
    const consume = vi
      .fn()
      .mockRejectedValueOnce(firstFailure)
      .mockImplementationOnce(async (options: { preflightProof?: symbol }) => {
        throw new CodexResetCreditSourcePreflightRejection(
          'accountChanged',
          state,
          'The selected Codex account changed before reset.',
          options.preflightProof
        )
      })
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test store has the exercised Store methods.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test rate-limit port implements the exercised methods.
      {
        ...createRateLimits(),
        getState: vi.fn(() => state),
        consumeCodexRateLimitResetCredit: consume
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test runtime home has the exercised methods.
      createRuntimeHome() as never
    )
    const key = '20202020-2020-4202-8202-202020202020'

    await expect(service.consumeRateLimitResetCredit(key, scope)).rejects.toBe(firstFailure)
    expect(consume).toHaveBeenCalledOnce()
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])
    expect(state.codex?.rateLimitResetCredits?.availableCount).toBe(1)
    expect(service.listAccounts().activeAccountId).toBe(account.id)

    await expect(
      service.consumeRateLimitResetCredit('21212121-2121-4212-8212-212121212121', scope)
    ).rejects.toThrow('The selected Codex account changed before reset.')
    expect(consume).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: key }))
    expect(store.getCodexResetCreditAttemptLedger().attempts).toMatchObject([
      { idempotencyKey: key, state: 'providerPending' }
    ])
  })
})
