import { useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AccountDeviceSignIn } from '../../../../shared/account-device-sign-in'
import { runAccountDeviceSignIn } from '../../../../shared/account-device-sign-in-client'
import { Button } from '../ui/button'
import { RemoteClaudeSignInSection } from './RemoteClaudeSignInSection'

export function RemoteAccountSignInSection({
  target,
  hostLabel,
  onComplete
}: {
  target: RuntimeClientTarget
  hostLabel: string
  onComplete: () => void
}): React.JSX.Element {
  const controller = useRef<AbortController | null>(null)
  const [state, setState] = useState<AccountDeviceSignIn | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(
    () => () => {
      controller.current?.abort()
      controller.current = null
    },
    []
  )
  function cancel(): void {
    controller.current?.abort()
    setState(null)
  }
  async function copyCode(): Promise<void> {
    if (!state?.userCode) {
      return
    }
    try {
      await navigator.clipboard.writeText(state.userCode)
      setCopied(true)
    } catch {
      setError('Could not copy the code. You can enter it manually.')
    }
  }

  async function start(): Promise<void> {
    if (controller.current) {
      return
    }
    const active = new AbortController()
    controller.current = active
    setState(null)
    setError('')
    setBusy(true)
    setCopied(false)
    try {
      await runAccountDeviceSignIn({
        request: (method, params) => callRuntimeRpc(target, method, params),
        signal: active.signal,
        onState: (next) => {
          if (active.signal.aborted) {
            return
          }
          setState(next)
          if (next.status === 'complete') {
            onComplete()
          }
        }
      })
    } catch (cause) {
      if (!active.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (controller.current === active) {
        controller.current = null
        setBusy(false)
      }
    }
  }

  return (
    <section className="space-y-3" aria-label="Server account sign-in">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate('settings.serverAccounts.title', 'Add accounts on this server')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.serverAccounts.scope',
            'Sign in for {{host}} in your browser. The login stays on that server and appears in its account pools.',
            { host: hostLabel }
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void start()}>
          {busy ? 'Waiting for sign-in…' : 'Add Codex account'}
        </Button>
        {busy ? (
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel sign-in
          </Button>
        ) : null}
      </div>
      {state?.status === 'waiting' && state.userCode && state.verificationUrl ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm">Open the sign-in page and enter this one-time code.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="select-all font-mono text-sm">{state.userCode}</code>
            <Button variant="outline" size="sm" onClick={() => void copyCode()}>
              {copied ? 'Copied' : 'Copy code'}
            </Button>
            <Button
              size="sm"
              onClick={() => void window.api.shell.openUrl(state.verificationUrl ?? '')}
            >
              Open sign-in page
            </Button>
          </div>
        </div>
      ) : null}
      {state?.status === 'complete' ? (
        <p role="status" className="text-sm">
          Account added to {hostLabel}. Select it below or add it to a pool.
        </p>
      ) : null}
      {error || state?.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error || state?.error}
        </p>
      ) : null}
      <RemoteClaudeSignInSection target={target} />
    </section>
  )
}
