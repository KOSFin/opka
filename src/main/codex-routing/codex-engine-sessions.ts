import type { NativeAccountPoolScope } from '../runtime/orchestration/db/account-pool-native-fences'
import type { CodexTranscriptReadBudget } from '../../shared/codex-rollout-jsonl-cursor'
import type { CodexRequestTurnIdentity } from './codex-request-turn-identity'
import { randomBytes } from 'node:crypto'
import { createCodexPoolTurnSession, type CodexPoolSelectionState } from './codex-pool-turn-session'
import type { CodexRoutingHttpOptions } from './codex-routing-http-server'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { createCodexHostQuotaRetry, type CodexHostQuotaFailure } from './codex-host-quota-retry'

export type NativeEngineSelection = Pick<
  ReturnType<ReturnType<typeof createCodexPoolTurnSession>['begin']>,
  'accountId' | 'policyRevision' | 'assignmentOwnerKey' | 'poolId'
>
export type NativeEngineLaunch = {
  launchId: string
  ownerPrefix: string
  canSwitch: () => boolean
  readBoundary?: (nextTurn?: CodexRequestTurnIdentity) => {
    canSwitch: () => boolean
    onBoundaryAccepted: () => void
  }
  canReplaceRejectedRequest?: (budget?: CodexTranscriptReadBudget) => boolean
  onRootThreadBound?: (
    threadId: string | null,
    context?: { settledPrevious: boolean; previousTurn?: { threadId: string; turnId: string } }
  ) => void
  onRootTurnAccepted?: (threadId: string, turnId: string) => void
  areRetainedTurnsSettled?: (
    turns: readonly { threadId: string; turnId: string }[],
    budget?: CodexTranscriptReadBudget,
    nextTurn?: { threadId: string; turnId: string }
  ) => boolean
  prepareQuotaRetry?: (signal: AbortSignal, budget?: CodexTranscriptReadBudget) => Promise<void>
  onAccountSelected?: (binding: NativeEngineSelection) => void
  initialAssignment?: { ownerKey: string; assertCurrent: () => void }
}
type SessionEntry = {
  launch: NativeEngineLaunch
  session: ReturnType<typeof createCodexPoolTurnSession>
  closed: boolean
  exited: boolean
  revoked: boolean
  controller: AbortController
}
export class CodexEngineSessions {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly changed = new Set<() => void>()
  constructor(
    private readonly options: {
      db: OrchestrationDb
      readState: (launchId: string) => CodexPoolSelectionState
      route: (
        accountId: string | null
      ) => Omit<ReturnType<CodexRoutingHttpOptions['prepare']>, 'finish'>
      accepting: () => boolean
      createAssignmentScope?: () => NativeAccountPoolScope
      recordQuotaFailure?: (event: CodexHostQuotaFailure) => boolean
    }
  ) {}
  register(launch: NativeEngineLaunch) {
    if (
      this.sessions.size >= 64 ||
      [...this.sessions.values()].some((e) => e.launch.launchId === launch.launchId)
    ) {
      throw new Error('Native routing session capacity or launch ownership is unavailable.')
    }
    const token = randomBytes(32).toString('hex')
    const entry = {
      launch,
      closed: false,
      exited: false,
      revoked: false,
      controller: new AbortController(),
      session: createCodexPoolTurnSession({
        db: this.options.db,
        assignmentScope: this.options.createAssignmentScope?.(),
        readState: () => this.options.readState(launch.launchId),
        ownerPrefix: launch.ownerPrefix,
        canSwitch: launch.canSwitch,
        readBoundary: launch.readBoundary,
        onRootThreadBound: launch.onRootThreadBound,
        canReplaceRejectedRequest: launch.canReplaceRejectedRequest,
        areRetainedTurnsSettled: launch.areRetainedTurnsSettled,
        initialAssignment: launch.initialAssignment
      })
    }
    this.sessions.set(token, entry)
    return {
      apiKey: token,
      readActiveRequests: () => entry.session.activeRequests,
      notifyBoundaryChanged: () => this.notify(),
      revoke: () => this.revokeEntry(token, entry),
      close: (verdict: 'exited' | 'unverifiable') => {
        entry.closed = true
        entry.exited ||= verdict === 'exited'
        entry.session.close(verdict)
        if (verdict === 'exited' && entry.session.activeRequests === 0) {
          this.sessions.delete(token)
        }
        this.notify()
      }
    }
  }
  prepare: CodexRoutingHttpOptions['prepare'] = (token, request) => {
    const entry = this.sessions.get(token)
    if (!entry || entry.closed || !this.options.accepting()) {
      throw new Error('Native routing is not ready.')
    }
    const binding = entry.session.begin(request.turn)
    const finish = () => {
      binding.finish()
      if ((entry.exited || entry.revoked) && entry.session.activeRequests === 0) {
        this.sessions.delete(token)
      }
      this.notify()
    }
    try {
      const route = this.options.route(binding.accountId)
      if (request.turn && !request.turn.parentThreadId && !request.turn.auxiliary) {
        entry.launch.onRootTurnAccepted?.(request.turn.threadId, request.turn.turnId)
      }
      entry.launch.onAccountSelected?.(binding)
      const retryRejectedQuota = this.options.recordQuotaFailure
        ? createCodexHostQuotaRetry({
            initial: binding,
            readPolicy: () => this.options.readState(entry.launch.launchId).policy,
            activeRequests: () => entry.session.activeRequests,
            recordFailure: this.options.recordQuotaFailure,
            replace: entry.session.replaceRejectedRequest,
            route: (accountId) => this.options.route(accountId),
            onAccountSelected: entry.launch.onAccountSelected,
            signal: entry.controller.signal,
            prepareReplacement: entry.launch.prepareQuotaRetry,
            finish
          })
        : undefined
      return {
        ...route,
        accountId: binding.accountId ?? undefined,
        quotaIdentity: binding.quotaIdentity ?? undefined,
        signal: entry.controller.signal,
        finish,
        retryRejectedQuota:
          request.turn?.auxiliary && retryRejectedQuota
            ? (failure, context) => retryRejectedQuota(failure, { ...context, allowRetry: false })
            : retryRejectedQuota
      }
    } catch (error) {
      finish()
      throw error
    }
  }
  async waitForSafeBoundary(signal: AbortSignal): Promise<void> {
    const safe = () => {
      try {
        return [...this.sessions.values()].every(
          (e) => !e.closed && e.session.activeRequests === 0 && e.launch.canSwitch()
        )
      } catch {
        return false
      }
    }
    return this.wait(signal, safe)
  }
  async waitForIdleRequests(signal: AbortSignal): Promise<void> {
    return this.wait(signal, () =>
      [...this.sessions.values()].every((entry) => entry.session.activeRequests === 0)
    )
  }
  assertAccountUnused(accountId: string): void {
    if (
      [...this.sessions.values()].some(
        (entry) =>
          (!entry.closed || entry.session.activeRequests > 0) &&
          entry.session.accountId === accountId
      )
    ) {
      throw new Error(
        'A native CLI still uses this account. Close it or change its routed account before removing the account.'
      )
    }
  }
  private async wait(signal: AbortSignal, safe: () => boolean): Promise<void> {
    signal.throwIfAborted()
    if (safe()) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.changed.delete(check)
        signal.removeEventListener('abort', abort)
      }
      const check = () => {
        if (safe()) {
          cleanup()
          resolve()
        }
      }
      const abort = () => {
        cleanup()
        reject(new Error('Native routing boundary wait was cancelled.'))
      }
      this.changed.add(check)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      } else {
        check()
      }
    })
  }
  notify(): void {
    this.changed.forEach((listener) => listener())
  }
  suspend(): void {
    this.sessions.forEach((entry) => {
      entry.closed = true
      entry.controller.abort()
      entry.session.close('unverifiable')
    })
    this.notify()
  }
  async revokeAll(): Promise<void> {
    await Promise.all([...this.sessions].map(([token, entry]) => this.revokeEntry(token, entry)))
  }
  private revokeEntry(token: string, entry: SessionEntry): Promise<void> {
    entry.closed = true
    entry.revoked = true
    entry.controller.abort()
    entry.session.revoke()
    if (entry.session.activeRequests === 0) {
      this.sessions.delete(token)
      this.notify()
      return Promise.resolve()
    }
    this.notify()
    return new Promise((resolve) => {
      const check = () => {
        if (entry.session.activeRequests === 0) {
          this.changed.delete(check)
          resolve()
        }
      }
      this.changed.add(check)
      check()
    })
  }
  get size(): number {
    return this.sessions.size
  }
}
