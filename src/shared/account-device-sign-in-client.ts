import { AccountDeviceSignInSchema, type AccountDeviceSignIn } from './account-device-sign-in'

type SignInRequest = (
  method: string,
  params: { provider: 'codex' } | { id: string }
) => Promise<unknown>

function waitForPoll(signal: AbortSignal): Promise<void> {
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
  onState
}: {
  request: SignInRequest
  signal: AbortSignal
  onState: (state: AccountDeviceSignIn) => void
}): Promise<void> {
  let state: AccountDeviceSignIn | undefined
  try {
    state = AccountDeviceSignInSchema.parse(
      await request('accounts.beginDeviceSignIn', { provider: 'codex' })
    )
    while (!signal.aborted) {
      onState(state)
      if (state.status !== 'starting' && state.status !== 'waiting') {
        return
      }
      await waitForPoll(signal)
      if (signal.aborted) {
        return
      }
      state = AccountDeviceSignInSchema.parse(
        await request('accounts.deviceSignIn', { id: state.id })
      )
    }
  } finally {
    if (signal.aborted && state && (state.status === 'starting' || state.status === 'waiting')) {
      await request('accounts.cancelDeviceSignIn', { id: state.id }).catch(() => undefined)
    }
  }
}
