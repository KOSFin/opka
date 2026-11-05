import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeSourceFixture } from '../claude-accounts/claude-native-source-test-fixtures'
import {
  getRuntimeClaudeNativeSources,
  beginRuntimeClaudeNativeSignIn,
  configureRuntimeClaudeNativeSources,
  runtimeClaudeNativeSignInLink,
  submitRuntimeClaudeNativeCode,
  cancelRuntimeClaudeNativeSignIn,
  shutdownRuntimeClaudeNativeSources
} from './runtime-claude-native-sources'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const link =
  'https://platform.claude.com/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=synthetic-state&code_challenge=synthetic-challenge'
function fixture() {
  const f = nativeSourceFixture()
  roots.push(f.root)
  const received: string[] = []
  f.login.mockImplementation(async (options) => {
    let finish = () => {}
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve
      options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
        once: true
      })
    })
    options.onLink?.(link)
    options.onCodeReady?.(async (code) => {
      options.assertExclusive()
      received.push(code)
      f.writeLogin(options.home)
      finish()
    })
    try {
      await done
    } finally {
      options.onCodeReady?.(null)
    }
  })
  const runtime = {}
  configureRuntimeClaudeNativeSources(runtime, f.options)
  return { ...f, runtime, received }
}
async function pending(f: ReturnType<typeof fixture>) {
  const reference = beginRuntimeClaudeNativeSignIn(f.runtime, f.account.id)
  await vi.waitFor(() =>
    expect(runtimeClaudeNativeSignInLink(f.runtime, reference)).toMatchObject({
      link,
      state: 'signing-in',
      requiresCode: true
    })
  )
  return reference
}

it('owns one source sign-in under the existing account and forwards duplicate code submissions only once', async () => {
  const f = fixture()
  const reference = await pending(f)
  const first = submitRuntimeClaudeNativeCode(
    f.runtime,
    reference,
    ' synthetic-code#synthetic-state '
  )
  const repeated = submitRuntimeClaudeNativeCode(
    f.runtime,
    reference,
    'synthetic-code#synthetic-state'
  )
  await Promise.all([first, repeated])
  expect(f.received).toEqual(['synthetic-code#synthetic-state'])
  await vi.waitFor(() =>
    expect(runtimeClaudeNativeSignInLink(f.runtime, reference)).toMatchObject({
      state: 'ready',
      link: null
    })
  )
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})

it('refuses foreign generations, changed code and multiline payloads without another stdin write', async () => {
  const f = fixture()
  const reference = await pending(f)
  await expect(
    submitRuntimeClaudeNativeCode(f.runtime, { ...reference, signInId: randomUUID() }, 'code#state')
  ).rejects.toThrow('ownership')
  await expect(
    submitRuntimeClaudeNativeCode(f.runtime, reference, 'code#state\nsecond-command')
  ).rejects.toThrow('unavailable')
  await submitRuntimeClaudeNativeCode(f.runtime, reference, 'code#state')
  await expect(
    submitRuntimeClaudeNativeCode(f.runtime, reference, 'different#state')
  ).rejects.toThrow('unavailable')
  expect(f.received).toEqual(['code#state'])
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})

it('cancels the exact pending source generation, clears its link and awaits owned shutdown', async () => {
  const f = fixture()
  const reference = await pending(f)
  expect(await cancelRuntimeClaudeNativeSignIn(f.runtime, reference)).toMatchObject({
    state: 'needs-sign-in',
    link: null
  })
  expect(f.received).toEqual([])
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})

it('rejects code forwarding after the captured profile owner changes', async () => {
  const f = fixture()
  const reference = await pending(f)
  f.loseProfile()
  await expect(submitRuntimeClaudeNativeCode(f.runtime, reference, 'code#state')).rejects.toThrow(
    'profile ownership'
  )
  expect(f.received).toEqual([])
  await expect(shutdownRuntimeClaudeNativeSources(f.runtime)).rejects.toThrow()
})

it('settles synchronous source preflight failure and permits a later owned retry', async () => {
  const f = fixture()
  const sources = getRuntimeClaudeNativeSources(f.runtime)
  if (!sources) {
    throw new Error('Missing configured source')
  }
  const preflight = vi.spyOn(sources, 'signIn').mockImplementationOnce(() => {
    throw new Error('preflight refused')
  })
  const reference = beginRuntimeClaudeNativeSignIn(f.runtime, f.account.id)
  await vi.waitFor(() =>
    expect(runtimeClaudeNativeSignInLink(f.runtime, reference)).toMatchObject({
      state: 'needs-sign-in',
      link: null
    })
  )
  expect(f.login).not.toHaveBeenCalled()
  preflight.mockRestore()
  const retry = await pending(f)
  expect(retry.signInId).not.toBe(reference.signInId)
  await cancelRuntimeClaudeNativeSignIn(f.runtime, retry)
  await shutdownRuntimeClaudeNativeSources(f.runtime)
})
