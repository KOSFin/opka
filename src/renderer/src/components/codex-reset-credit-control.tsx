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
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  getProviderAccountsSnapshotVersion,
  publishProviderAccountsSnapshotIfCurrent,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import {
  claimCodexResetCreditTransaction,
  codexResetCreditTransactionKey,
  mergeCodexResetCreditResult,
  releaseCodexResetCreditTransaction
} from './codex-reset-credit-transaction'

type ResetReply = {
  outcome?: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'
  status?: 'rejectedBeforeProvider'
  scope: CodexResetCreditExpectedScope
  snapshot: ProviderAccountsSnapshot & { rateLimits: RateLimitState }
}

export function CodexResetCreditControl({
  account,
  limits,
  rateLimitTarget,
  owner,
  ownerLabel,
  verified,
  active = true
}: {
  account: CodexManagedAccountSummary | null
  limits: ProviderRateLimits | null
  rateLimitTarget: RateLimitRuntimeTarget
  owner: RuntimeClientTarget
  ownerLabel: string
  verified: boolean
  active?: boolean
}): React.JSX.Element | null {
  const [supported, setSupported] = useState(owner.kind === 'local')
  const [confirming, setConfirming] = useState<{
    scope: CodexResetCreditExpectedScope
    ownerKey: string
    viewVersion: number
  } | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(false)
  const resetButtonRef = useRef<HTMLButtonElement>(null)
  const focusViewVersion = useRef<number | null>(null)
  const ownerKey = owner.kind === 'local' ? 'local' : `environment:${owner.environmentId}`
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const credits = limits?.rateLimitResetCredits
  const expires = credits?.nextExpiresAt
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
  const scopeFingerprint = scope ? JSON.stringify(scope) : 'none'
  const currentView = useRef({ ownerKey, scopeFingerprint, limits, version: 0 })
  if (
    currentView.current.ownerKey !== ownerKey ||
    currentView.current.scopeFingerprint !== scopeFingerprint ||
    currentView.current.limits !== limits
  ) {
    currentView.current = {
      ownerKey,
      scopeFingerprint,
      limits,
      version: currentView.current.version + 1
    }
  }
  const pairingRevision =
    environmentId === null ? undefined : getRuntimeEnvironmentRevision(environmentId)
  const transactionKey = scope
    ? codexResetCreditTransactionKey(ownerKey, pairingRevision, scope)
    : null
  const busy = busyKey !== null && busyKey === transactionKey

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setNow(Date.now())
  }, [limits])

  useEffect(() => {
    if (typeof expires !== 'number' || !Number.isFinite(expires)) {
      return
    }
    const delay = expires - Date.now() + 1
    if (delay <= 0) {
      return
    }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [expires])

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
  const expiry =
    typeof expires === 'number' && Number.isFinite(expires)
      ? new Date(expires).toLocaleString()
      : null
  const creditIsCurrent = (): boolean =>
    expires == null || (Number.isFinite(expires) && expires > Date.now())
  const fresh = !!limits && now - limits.updatedAt < 10 * 60_000 && limits.updatedAt <= now + 60_000
  const canUse =
    supported &&
    verified &&
    active &&
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

  async function consume(
    confirmed: CodexResetCreditExpectedScope,
    confirmedViewVersion: number
  ): Promise<void> {
    const requestKey = codexResetCreditTransactionKey(ownerKey, pairingRevision, confirmed)
    if (
      !mounted.current ||
      currentView.current.version !== confirmedViewVersion ||
      !claimCodexResetCreditTransaction(requestKey)
    ) {
      return
    }
    setBusyKey(requestKey)
    const sourceVersion = getProviderAccountsSnapshotVersion(owner)
    const baselineCodex = owner.kind === 'local' ? useAppStore.getState().rateLimits.codex : null
    const stillCurrent = (): boolean =>
      mounted.current &&
      currentView.current.version === confirmedViewVersion &&
      (environmentId === null || getRuntimeEnvironmentRevision(environmentId) === pairingRevision)
    try {
      if (owner.kind === 'local' && baselineCodex !== limits) {
        throw new Error('The account quota changed. Refresh before using a reset.')
      }
      if (owner.kind === 'environment') {
        const capability = await runtimeEnvironmentSupportsCapability(
          owner.environmentId,
          CODEX_RESET_CREDIT_RUNTIME_CAPABILITY
        )
        if (
          !capability ||
          !stillCurrent() ||
          getProviderAccountsSnapshotVersion(owner) !== sourceVersion
        ) {
          throw new Error('Reset unavailable on this host.')
        }
      }
      if (!stillCurrent() || !creditIsCurrent()) {
        return
      }
      const reply = await callRuntimeRpc<ResetReply>(
        owner,
        'accounts.consumeCodexResetCredit',
        {
          idempotencyKey: createBrowserUuid(),
          expectedScope: confirmed
        },
        { timeoutMs: 90_000, expectedEnvironmentPairingRevision: pairingRevision }
      )
      if (!stillCurrent()) {
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
      let applied = false
      if (owner.kind === 'local') {
        useAppStore.setState((state) => {
          const rateLimits = mergeCodexResetCreditResult(
            state.rateLimits,
            baselineCodex,
            confirmed,
            reply.snapshot.rateLimits
          )
          applied = rateLimits !== null
          return rateLimits ? { rateLimits } : state
        })
      } else if (getProviderAccountsSnapshotVersion(owner) === sourceVersion) {
        applied = publishProviderAccountsSnapshotIfCurrent(owner, reply.snapshot, sourceVersion)
      }
      if (!applied) {
        toast.error('Quota changed while the reset was pending', {
          description: 'Review the latest account and quota before another attempt.'
        })
        return
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
      if (stillCurrent()) {
        toast.error('Reset outcome needs review', {
          description: `${error instanceof Error ? error.message : String(error)} Refresh this account before another attempt; the host will reconcile an uncertain result.`
        })
      }
    } finally {
      releaseCodexResetCreditTransaction(requestKey)
      if (mounted.current) {
        setBusyKey((current) => (current === requestKey ? null : current))
      }
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
          ref={resetButtonRef}
          variant="outline"
          size="xs"
          disabled={!canUse}
          onClick={() => {
            if (scope && creditIsCurrent()) {
              focusViewVersion.current = currentView.current.version
              setConfirming({ scope, ownerKey, viewVersion: currentView.current.version })
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
            : !active
              ? ' · Select this account to use a reset'
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
        <DialogContent
          surface="security"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (focusViewVersion.current === currentView.current.version) {
              resetButtonRef.current?.focus()
            }
            focusViewVersion.current = null
          }}
        >
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
              disabled={
                busy ||
                !canUse ||
                confirming?.ownerKey !== ownerKey ||
                confirming?.viewVersion !== currentView.current.version
              }
              onClick={() => {
                const pinned = confirming
                setConfirming(null)
                if (
                  pinned?.ownerKey === ownerKey &&
                  pinned.viewVersion === currentView.current.version &&
                  creditIsCurrent()
                ) {
                  void consume(pinned.scope, pinned.viewVersion)
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
