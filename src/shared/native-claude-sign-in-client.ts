import type { z } from 'zod'
import {
  NativeClaudeRefreshSignInReference,
  NativeClaudeRefreshSignInLinkResult,
  NativeClaudeRefreshSignInCodeParams
} from './native-claude-refresh-source'
import { waitForAccountSignInPoll } from './account-device-sign-in-client'

export type NativeClaudeSignInRequest = (
  method: string,
  params:
    | { accountId: string }
    | NativeClaudeRefreshSignInReference
    | {
        accountId: string
        signInId: string
        code: string
      }
) => Promise<unknown>
export type NativeClaudeSignInView = z.infer<typeof NativeClaudeRefreshSignInLinkResult> & {
  reference: NativeClaudeRefreshSignInReference
}

/** Browser auth belongs to this account and caller, including cancellation after a late begin. */
export async function runNativeClaudeSignIn(options: {
  request: NativeClaudeSignInRequest
  accountId: string
  signal: AbortSignal
  onState: (state: NativeClaudeSignInView) => void
  waitUntilActive?: (signal: AbortSignal) => Promise<void>
}): Promise<void> {
  if (options.signal.aborted) {
    return
  }
  let reference: NativeClaudeRefreshSignInReference | undefined
  let pending = true
  try {
    const started = NativeClaudeRefreshSignInReference.parse(
      await options.request('accounts.beginNativeClaudeRefreshSignIn', {
        accountId: options.accountId
      })
    )
    if (started.accountId !== options.accountId) {
      throw new Error('Sign-in account changed.')
    }
    reference = started
    while (!options.signal.aborted) {
      await options.waitUntilActive?.(options.signal)
      if (options.signal.aborted) {
        return
      }
      const state = NativeClaudeRefreshSignInLinkResult.parse(
        await options.request('accounts.getNativeClaudeRefreshSignInLink', reference)
      )
      if (options.signal.aborted) {
        return
      }
      pending = state.state === 'signing-in'
      options.onState({ ...state, reference })
      if (!pending) {
        return
      }
      await waitForAccountSignInPoll(options.signal)
    }
  } catch {
    throw new Error('Claude CLI connection could not be completed. Try again.')
  } finally {
    if (reference && pending) {
      await options
        .request('accounts.cancelNativeClaudeRefreshSignIn', reference)
        .catch(() => undefined)
    }
  }
}

export async function submitNativeClaudeSignInCode(
  request: NativeClaudeSignInRequest,
  reference: NativeClaudeRefreshSignInReference,
  code: string
): Promise<void> {
  try {
    const params = NativeClaudeRefreshSignInCodeParams.parse({ ...reference, code: code.trim() })
    NativeClaudeRefreshSignInLinkResult.parse(
      await request('accounts.submitNativeClaudeRefreshSignInCode', params)
    )
  } catch {
    throw new Error('Could not confirm the code. Wait for sign-in status or start a new sign-in.')
  }
}
