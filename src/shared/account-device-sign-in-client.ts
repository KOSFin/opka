import { AccountDeviceSignInSchema, type AccountDeviceSignIn } from './account-device-sign-in'
import type { CodexRoutingSignInTarget } from './native-account-routing'

export type AccountDeviceSignInRequest = (
  method: string,
  params: { provider: 'codex' } | { id: string } | CodexRoutingSignInTarget
) => Promise<unknown>

export function waitForAccountSignInPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return resolve()
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, 1000)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** The caller binds requests to one host; leaving that view cancels only its own pending login. */
export async function runAccountDeviceSignIn({
  request,
  signal,
  onState,
  routingAccount,
  waitUntilActive
}: {
  request: AccountDeviceSignInRequest
  signal: AbortSignal
  onState: (state: AccountDeviceSignIn) => void
  routingAccount?: CodexRoutingSignInTarget
  waitUntilActive?: (signal: AbortSignal) => Promise<void>
}): Promise<void> {
  let state: AccountDeviceSignIn | undefined
  try {
    state = AccountDeviceSignInSchema.parse(
      await request(
        routingAccount ? 'accounts.beginCodexRoutingSignIn' : 'accounts.beginDeviceSignIn',
        routingAccount ?? { provider: 'codex' }
      )
    )
    while (!signal.aborted) {
      onState(state)
      if (state.status !== 'starting' && state.status !== 'waiting') {
        return
      }
      await waitForAccountSignInPoll(signal)
      if (signal.aborted) {
        return
      }
      await waitUntilActive?.(signal)
      if (signal.aborted) {
        return
      }
      state = AccountDeviceSignInSchema.parse(
        await request(routingAccount ? 'accounts.codexRoutingSignIn' : 'accounts.deviceSignIn', {
          id: state.id
        })
      )
    }
  } finally {
    if (signal.aborted && state && (state.status === 'starting' || state.status === 'waiting')) {
      await request(
        routingAccount ? 'accounts.cancelCodexRoutingSignIn' : 'accounts.cancelDeviceSignIn',
        { id: state.id }
      ).catch(() => undefined)
    }
  }
}
