import type { CodexEngineSessions } from './codex-engine-sessions'
import type { CodexEngineLifecycle } from './codex-engine-lifecycle'
import type { EngineGrantDescriptor, EngineGrantAccount } from './engine-grant-files'

type Options = {
  queueTimeoutMs: number
  sessions: CodexEngineSessions
  lifecycle: CodexEngineLifecycle
  connections(): EngineGrantDescriptor[]
  accounts(): EngineGrantAccount[]
  closing(): boolean
  transition(parent: AbortSignal, operation: (signal: AbortSignal) => Promise<void>): Promise<void>
}

/** Restart only after healthy requests drain and the execution host proves engine exit. */
export class CodexEngineRequestRecovery {
  phase: 'idle' | 'waiting-for-idle' | 'proving-exit' | 'restarting' | 'ready' | 'fenced' = 'idle'
  failureCode: 'idle-wait-cancelled' | 'exit-or-cleanup-unverifiable' | 'restart-failed' | null =
    null
  private active: Promise<void> | undefined
  private readonly waiters = new Set<(error?: Error) => void>()
  private readonly controller = new AbortController()
  constructor(private readonly options: Options) {}
  request(): void {
    if (this.active || this.options.closing() || this.controller.signal.aborted) {
      return
    }
    this.active = this.recover().then(
      () => this.settleWaiters(),
      () => {
        this.failureCode =
          this.phase === 'restarting'
            ? 'restart-failed'
            : this.phase === 'waiting-for-idle'
              ? 'idle-wait-cancelled'
              : 'exit-or-cleanup-unverifiable'
        this.phase = 'fenced'
        this.settleWaiters(new Error('Native engine recovery remains fenced.'))
      }
    )
  }
  private settleWaiters(error?: Error): void {
    this.active = undefined
    this.waiters.forEach((finish) => finish(error))
  }
  async waitForReady(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.active) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        this.waiters.delete(finish)
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const abort = () => finish(new Error('Native engine recovery wait was cancelled.'))
      const timer = setTimeout(
        () =>
          finish(
            Object.assign(new Error('Native engine recovery queue deadline elapsed.'), {
              code: 'RECOVERY_QUEUE_TIMEOUT'
            })
          ),
        this.options.queueTimeoutMs
      )
      signal.addEventListener('abort', abort, { once: true })
      this.waiters.add(finish)
      if (signal.aborted) {
        abort()
      }
    })
  }
  shutdown(): void {
    this.controller.abort()
  }
  private async recover(): Promise<void> {
    const { sessions, lifecycle } = this.options
    this.failureCode = null
    this.phase = 'waiting-for-idle'
    // Healthy model turns may outlive the short engine-transition deadline.
    await sessions.waitForNonHeldRequests(this.controller.signal)
    if (!sessions.hasHeldRequests) {
      this.phase = 'ready'
      return
    }
    await this.options.transition(this.controller.signal, async (signal) => {
      await sessions.waitForNonHeldRequests(signal)
      if (!sessions.hasHeldRequests) {
        this.phase = 'ready'
        return
      }
      this.phase = 'proving-exit'
      await lifecycle.stop()
      await sessions.releaseHeldRequestsAfterEngineExit(signal)
      this.phase = 'restarting'
      await lifecycle.start(this.options.connections(), signal, this.options.accounts())
      sessions.resumeAfterEngineRecovery()
      this.phase = 'ready'
    })
  }
}
