import { useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  runNativeClaudeSignIn,
  submitNativeClaudeSignInCode,
  type NativeClaudeSignInView
} from '../../../../shared/native-claude-sign-in-client'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

export function NativeClaudeSignInSection({
  target,
  accountId,
  onComplete
}: {
  target: RuntimeClientTarget
  accountId: string
  onComplete: () => void
}) {
  const controller = useRef<AbortController | null>(null)
  const [state, setState] = useState<NativeClaudeSignInView | null>(null)
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const request = (method: string, params: unknown) => callRuntimeRpc(target, method, params)
  useEffect(() => () => controller.current?.abort(), [])

  async function start() {
    if (controller.current) {
      return
    }
    const active = new AbortController()
    controller.current = active
    setState(null)
    setBusy(true)
    setSubmitting(false)
    setCode('')
    setCopied(false)
    setError('')
    try {
      await runNativeClaudeSignIn({
        request,
        accountId,
        signal: active.signal,
        onState(next) {
          if (!active.signal.aborted) {
            setState(next)
            if (next.state === 'ready') {
              onComplete()
            } else if (next.state !== 'signing-in') {
              setError('Claude sign-in did not finish. Start a new sign-in to retry.')
            }
          }
        }
      })
    } catch {
      if (!active.signal.aborted) {
        setError('Claude CLI connection could not be completed. Try again.')
      }
    } finally {
      if (controller.current === active) {
        controller.current = null
        setBusy(false)
        setCode('')
      }
    }
  }
  async function submitCode() {
    if (!state || !code || submitting || !controller.current) {
      return
    }
    const active = controller.current
    const value = code
    setCode('')
    setSubmitting(true)
    setError('')
    try {
      await submitNativeClaudeSignInCode(request, state.reference, value)
    } catch {
      if (!active.signal.aborted) {
        setError('Could not confirm the code. Wait for sign-in status or start a new sign-in.')
      }
    }
  }
  function cancel() {
    controller.current?.abort()
    setState(null)
    setCode('')
  }
  async function copyLink() {
    if (!state?.link) {
      return
    }
    try {
      await navigator.clipboard.writeText(state.link)
      setCopied(true)
    } catch {
      setError('Could not copy the link. Use Open sign-in page instead.')
    }
  }

  return (
    <section className="space-y-2" aria-label="Native Claude CLI connection">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void start()}>
          {busy ? 'Connecting account…' : 'Connect for CLI switching'}
        </Button>
        {busy ? (
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel sign-in
          </Button>
        ) : null}
      </div>
      {state?.link && busy ? (
        <>
          <p className="text-xs text-muted-foreground">
            Sign in with this same Claude account. Paste the confirmation code from the browser
            below.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void window.api.shell.openUrl(state.link ?? '')}>
              Open sign-in page
            </Button>
            <Button variant="outline" size="sm" onClick={() => void copyLink()}>
              {copied ? 'Link copied' : 'Copy sign-in link'}
            </Button>
          </div>
          {state.requiresCode ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCode()
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                aria-label="Claude sign-in code"
                className="max-w-sm"
                value={code}
                disabled={submitting}
                onChange={(event) => setCode(event.target.value)}
                maxLength={4096}
              />
              <Button type="submit" size="sm" disabled={!code || submitting}>
                {submitting ? 'Waiting for confirmation…' : 'Confirm sign-in code'}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
