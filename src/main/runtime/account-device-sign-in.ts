import { randomUUID } from 'node:crypto'
import type {
  AccountDeviceSignIn,
  CodexDeviceAuthorization
} from '../../shared/account-device-sign-in'
import { codexDeviceSignInFailure } from '../codex-accounts/codex-device-authorization'

type SignIn = {
  owner: string
  controller: AbortController
  state: AccountDeviceSignIn
  finished: boolean
  done: Promise<void>
  timer: ReturnType<typeof setTimeout> | null
}
type StartSignIn = (
  onPrompt: (prompt: CodexDeviceAuthorization) => void,
  signal: AbortSignal
) => Promise<unknown>
const pending = (entry: SignIn): boolean => !entry.finished

/** Only the authenticated caller that began an enrollment can read or cancel its code. */
export class AccountDeviceSignIns {
  private current: SignIn | null = null
  private stopping = false
  constructor(private readonly startSignIn: StartSignIn) {}

  begin(owner: string): AccountDeviceSignIn {
    if (this.stopping) {
      throw new Error('This host is shutting down. Reconnect before signing in.')
    }
    const previous = this.current
    if (previous && pending(previous)) {
      if (previous.owner !== owner) {
        throw new Error('Another device is already signing in on this host.')
      }
      if (previous.controller.signal.aborted) {
        throw new Error('The previous sign-in is closing. Try again shortly.')
      }
      return this.get(owner, previous.state.id)
    }
    const entry: SignIn = {
      owner,
      controller: new AbortController(),
      finished: false,
      done: Promise.resolve(),
      timer: null,
      state: {
        id: randomUUID(),
        provider: 'codex',
        status: 'starting',
        expiresAt: Date.now() + 15 * 60_000
      }
    }
    this.current = entry
    entry.timer = setTimeout(() => this.expire(entry), 15 * 60_000)
    entry.timer.unref()
    entry.done = Promise.resolve()
      .then(() =>
        this.startSignIn((prompt) => {
          if (entry.finished || entry.controller.signal.aborted) {
            return
          }
          if (Date.now() >= entry.state.expiresAt) {
            this.expire(entry)
            return
          }
          entry.state = { ...entry.state, ...prompt, status: 'waiting' }
        }, entry.controller.signal)
      )
      .then(
        () => {
          // An accepted cancellation cannot revoke credentials already committed by the provider.
          entry.state = this.settled(entry, 'complete')
        },
        (error: unknown) => {
          const expired = Date.now() >= entry.state.expiresAt
          entry.state = this.settled(
            entry,
            expired ? 'failed' : entry.controller.signal.aborted ? 'cancelled' : 'failed',
            expired
              ? 'Codex sign-in expired. Start a new sign-in.'
              : codexDeviceSignInFailure(error)
          )
        }
      )
      .finally(() => {
        entry.finished = true
        if (entry.timer) {
          clearTimeout(entry.timer)
        }
        entry.timer = null
      })
    return { ...entry.state }
  }

  get(owner: string, id: string): AccountDeviceSignIn {
    const entry = this.require(owner, id)
    if (pending(entry) && !entry.controller.signal.aborted && Date.now() >= entry.state.expiresAt) {
      this.expire(entry)
    }
    return { ...entry.state }
  }

  cancel(owner: string, id: string): AccountDeviceSignIn {
    const entry = this.require(owner, id)
    if (pending(entry)) {
      entry.state = this.settled(entry, 'cancelled')
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.timer = null
      entry.controller.abort()
    }
    return { ...entry.state }
  }

  stop(): Promise<void> | null {
    this.stopping = true
    if (!this.current || !pending(this.current)) {
      return null
    }
    this.cancel(this.current.owner, this.current.state.id)
    return this.current.done
  }

  private expire(entry: SignIn): void {
    if (entry.finished) {
      return
    }
    entry.state = this.settled(entry, 'failed', 'Codex sign-in expired. Start a new sign-in.')
    entry.controller.abort()
  }

  private require(owner: string, id: string): SignIn {
    if (!this.current || this.current.owner !== owner || this.current.state.id !== id) {
      throw new Error('This sign-in is not available to this device. Start a new sign-in.')
    }
    return this.current
  }

  private settled(
    entry: SignIn,
    status: AccountDeviceSignIn['status'],
    error?: string
  ): AccountDeviceSignIn {
    return {
      id: entry.state.id,
      provider: 'codex',
      status,
      expiresAt: entry.state.expiresAt,
      ...(error ? { error } : {})
    }
  }
}
