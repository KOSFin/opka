import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { buildCodexResetCreditExpectedScope } from '../../../shared/codex-reset-credit-scope'
import type { CodexResetCreditExpectedScope } from '../../../shared/codex-reset-credit-scope'
import type { CodexManagedAccountSummary } from '../../../shared/managed-account-types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../shared/account-runtime-capabilities'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '../store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { usageMatchesAccount } from '../../../shared/usage-account-provenance'
import { getCodexStatusRuntimeKey } from './status-bar/status-bar-runtime-targets'

type ResetReply = {
  outcome?: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'
  status?: 'rejectedBeforeProvider'
  scope: CodexResetCreditExpectedScope
  snapshot: { rateLimits: RateLimitState }
}

export function CodexResetCreditControl({
  account,
  limits,
  rateLimitTarget,
  owner,
  ownerLabel,
  verified
}: {
  account: CodexManagedAccountSummary | null
  limits: ProviderRateLimits | null
  rateLimitTarget: RateLimitRuntimeTarget
  owner: RuntimeClientTarget
  ownerLabel: string
  verified: boolean
}): React.JSX.Element | null {
  const [supported, setSupported] = useState(owner.kind === 'local')
  const [confirming, setConfirming] = useState<{
    scope: CodexResetCreditExpectedScope
    ownerKey: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const inFlight = useRef(false)
  const ownerKey = owner.kind === 'local' ? 'local' : `environment:${owner.environmentId}`
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const currentOwner = useRef(ownerKey)
  currentOwner.current = ownerKey
  const credits = limits?.rateLimitResetCredits
  const count = credits?.availableCount
  const hasAccountProof =
    account !== null &&
    usageMatchesAccount(limits, getCodexStatusRuntimeKey(rateLimitTarget), account.id)
  const scope = useMemo(
    () =>
      hasAccountProof
        ? buildCodexResetCreditExpectedScope({ account, limits, target: rateLimitTarget })
        : null,
    [account, hasAccountProof, limits, rateLimitTarget]
  )

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setConfirming(null)
    if (environmentId === null) {
      setSupported(true)
      return
    }
    let active = true
    setSupported(false)
    void runtimeEnvironmentSupportsCapability(environmentId, CODEX_RESET_CREDIT_RUNTIME_CAPABILITY)
      .then((value) => {
        if (active) {
          setSupported(value)
        }
      })
      .catch(() => {
        if (active) {
          setSupported(false)
        }
      })
    return () => {
      active = false
    }
  }, [environmentId, ownerKey])

  if (count == null || !Number.isInteger(count) || count < 0) {
    return null
  }
  const expires = credits?.nextExpiresAt
  const expiry =
    typeof expires === 'number' && Number.isFinite(expires)
      ? new Date(expires).toLocaleString()
      : null
  const fresh = !!limits && now - limits.updatedAt < 10 * 60_000 && limits.updatedAt <= now + 60_000
  const canUse =
    supported &&
    verified &&
    !!scope &&
    count > 0 &&
    !busy &&
    limits?.status === 'ok' &&
    fresh &&
    (expires == null || expires > now)
  const accountLabel = account?.email ?? 'Unknown account'
  const targetLabel =
    rateLimitTarget.runtime === 'wsl'
      ? `${ownerLabel} · WSL ${rateLimitTarget.wslDistro ?? ''}`
      : ownerLabel

  async function consume(confirmed: CodexResetCreditExpectedScope): Promise<void> {
    if (inFlight.current || currentOwner.current !== ownerKey) {
      return
    }
    inFlight.current = true
    setBusy(true)
    try {
      if (owner.kind === 'environment') {
        const capability = await runtimeEnvironmentSupportsCapability(
          owner.environmentId,
          CODEX_RESET_CREDIT_RUNTIME_CAPABILITY
        )
        if (!capability || currentOwner.current !== ownerKey) {
          throw new Error('Reset unavailable on this host.')
        }
      }
      const reply = await callRuntimeRpc<ResetReply>(
        owner,
        'accounts.consumeCodexResetCredit',
        {
          idempotencyKey: createBrowserUuid(),
          expectedScope: confirmed
        },
        { timeoutMs: 90_000 }
      )
      if (currentOwner.current !== ownerKey) {
        return
      }
      if (
        reply.scope.accountId !== confirmed.accountId ||
        reply.scope.accountRevision !== confirmed.accountRevision ||
        reply.scope.target.runtime !== confirmed.target.runtime ||
        reply.scope.target.wslDistro !== confirmed.target.wslDistro
      ) {
        throw new Error('The host returned a different account. Refresh Usage before trying again.')
      }
      if (owner.kind === 'local') {
        useAppStore.setState({ rateLimits: reply.snapshot.rateLimits })
      }
      if (reply.status === 'rejectedBeforeProvider') {
        toast.error('Reset details changed', {
          description: 'Review the refreshed account and quota, then confirm again.'
        })
      } else {
        toast.success(
          reply.outcome === 'reset'
            ? 'Rate limits reset'
            : reply.outcome === 'alreadyRedeemed'
              ? 'Reset already applied'
              : reply.outcome === 'noCredit'
                ? 'No reset available'
                : 'No eligible window to reset'
        )
      }
    } catch (error) {
      if (currentOwner.current === ownerKey) {
        toast.error('Reset outcome needs review', {
          description: `${error instanceof Error ? error.message : String(error)} Refresh this account before another attempt; the host will reconcile an uncertain result.`
        })
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1 text-2xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {count} {count === 1 ? 'manual reset' : 'manual resets'} available
          {expiry ? ` · ${count === 1 ? 'Expires' : 'Next expires'} ${expiry}` : ''}
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={!canUse}
          onClick={() => {
            if (scope) {
              setConfirming({ scope, ownerKey })
            }
          }}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
          Use reset
        </Button>
      </div>
      <p>
        {accountLabel} · {targetLabel}
        {!supported
          ? ' · Reset unavailable on this host'
          : !verified
            ? ' · Host not verified'
            : count === 0
              ? ' · No resets left'
              : !hasAccountProof
                ? ' · Account quota unverified'
                : !fresh || limits?.status !== 'ok'
                  ? ' · Refresh stale usage'
                  : ''}
      </p>
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null)
          }
        }}
      >
        <DialogContent surface="security">
          <DialogHeader>
            <DialogTitle>Use one manual reset?</DialogTitle>
            <DialogDescription>
              This spends one of {count} available resets for {accountLabel} on {targetLabel}.
              {expiry ? ` ${count === 1 ? 'It expires' : 'The next one expires'} ${expiry}.` : ''}{' '}
              Manual resets are separate from the scheduled usage-window refresh.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !canUse || confirming?.ownerKey !== ownerKey}
              onClick={() => {
                const pinned = confirming
                setConfirming(null)
                if (pinned?.ownerKey === ownerKey) {
                  void consume(pinned.scope)
                }
              }}
            >
              Use reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
