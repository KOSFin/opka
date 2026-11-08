import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'
import type { RpcClient } from '../transport/rpc-client'
import type { AccountsSnapshot } from './account-usage-state'
import {
  getCodexResetCreditOutcomeCopy,
  getCodexResetCreditScope,
  getCodexResetCreditSummary,
  requestCodexResetCredit
} from './codex-reset-credit'
import { useCodexResetCreditCapability } from './codex-reset-credit-capability'

type CodexResetDialog = { title: string; message: string }

function describeScope(
  snapshot: AccountsSnapshot,
  scope: CodexResetCreditExpectedScope,
  hostName: string
): string {
  const account = snapshot.codex.accounts.find((candidate) => candidate.id === scope.accountId)
  const identity = account?.email ?? 'the selected managed account'
  if (scope.target.runtime === 'host') {
    return `${identity} on ${hostName}`
  }
  return `${identity} on ${hostName} · WSL ${scope.target.wslDistro}`
}

export function useCodexResetCreditAction({
  client,
  connected,
  snapshot,
  hostName,
  hostId,
  accountMutationBusy,
  onSnapshot,
  onNotice
}: {
  client: RpcClient | null
  connected: boolean
  snapshot: AccountsSnapshot | null
  hostName: string
  hostId: string
  accountMutationBusy: boolean
  onSnapshot: (snapshot: AccountsSnapshot) => void
  onNotice: (notice: CodexResetDialog) => void
}): {
  supported: boolean
  resetting: boolean
  resetScope: CodexResetCreditExpectedScope | null
  scopeLabel: string | null
  confirmReset: () => void
  /** The pending confirmation prompt, or null when none is open. */
  confirmation: CodexResetDialog | null
  acceptReset: () => void
  cancelReset: () => void
} {
  const supported = useCodexResetCreditCapability(client, connected)
  const [resetting, setResetting] = useState(false)
  const [confirming, setConfirming] = useState<{
    scope: CodexResetCreditExpectedScope
    label: string
    count: number
    expiry: string | null
    client: RpcClient
    generation: number
    hostId: string
  } | null>(null)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const currentHostRef = useRef(hostId)
  currentHostRef.current = hostId
  const resetScope = useMemo(
    () => (snapshot ? getCodexResetCreditScope(snapshot) : null),
    [snapshot]
  )
  const scopeLabel = useMemo(
    () =>
      snapshot && resetScope ? describeScope(snapshot, resetScope, hostName || 'this host') : null,
    [hostName, resetScope, snapshot]
  )

  const consume = useCallback(
    async (
      expectedScope: CodexResetCreditExpectedScope,
      confirmedClient: RpcClient,
      confirmedHostId: string,
      confirmedGeneration: number
    ) => {
      if (
        !mountedRef.current ||
        inFlightRef.current ||
        currentHostRef.current !== confirmedHostId
      ) {
        return
      }
      inFlightRef.current = true
      setResetting(true)
      try {
        const result = await requestCodexResetCredit(confirmedClient, expectedScope)
        if (
          !mountedRef.current ||
          currentHostRef.current !== confirmedHostId ||
          (confirmedClient.getGeneration?.() ?? 0) !== confirmedGeneration
        ) {
          return
        }
        onSnapshot(result.snapshot)
        if ('status' in result) {
          onNotice({
            title: 'Reset details changed',
            message:
              'The account or reset offer changed before the host contacted Codex. Review the updated details, then confirm again.'
          })
          return
        }
        onNotice(getCodexResetCreditOutcomeCopy(result.outcome))
      } catch (error) {
        if (!mountedRef.current || currentHostRef.current !== confirmedHostId) {
          return
        }
        onNotice({
          title: 'Could not reset rate limits',
          message: error instanceof Error ? error.message : String(error)
        })
      } finally {
        inFlightRef.current = false
        if (mountedRef.current) {
          setResetting(false)
        }
      }
    },
    [onNotice, onSnapshot]
  )

  const confirmReset = useCallback(() => {
    if (
      !mountedRef.current ||
      !client ||
      !supported ||
      !connected ||
      accountMutationBusy ||
      resetting ||
      !resetScope ||
      !snapshot ||
      !snapshot.rateLimits.codex ||
      Date.now() - snapshot.rateLimits.codex.updatedAt >= 10 * 60_000
    ) {
      return
    }
    // The scope is pinned when the prompt opens, so a snapshot arriving under it changes nothing.
    const summary = getCodexResetCreditSummary(snapshot.rateLimits.codex, Date.now())
    if (!summary || summary.availableCount === 0) {
      return
    }
    setConfirming({
      scope: resetScope,
      label: describeScope(snapshot, resetScope, hostName || 'this host'),
      count: summary.availableCount,
      expiry: summary.expiryLabel,
      client,
      generation: client.getGeneration?.() ?? 0,
      hostId
    })
  }, [
    accountMutationBusy,
    client,
    connected,
    hostId,
    hostName,
    resetScope,
    resetting,
    snapshot,
    supported
  ])

  const acceptReset = useCallback(() => {
    if (
      mountedRef.current &&
      confirming &&
      confirming.client === client &&
      confirming.generation === (client?.getGeneration?.() ?? 0) &&
      confirming.hostId === hostId &&
      confirming.hostId === currentHostRef.current &&
      connected
    ) {
      setConfirming(null)
      void consume(confirming.scope, confirming.client, confirming.hostId, confirming.generation)
    }
  }, [client, connected, confirming, consume, hostId])
  const cancelReset = useCallback(() => setConfirming(null), [])
  const confirmation = confirming
    ? {
        title: 'Use a rate-limit reset?',
        message: `This spends one of ${confirming.count} available resets for ${confirming.label}.${confirming.expiry ? ` ${confirming.expiry}.` : ''} Reset credits expire separately from the scheduled usage-window refresh.`
      }
    : null

  return {
    supported,
    resetting,
    resetScope,
    scopeLabel,
    confirmReset,
    confirmation,
    acceptReset,
    cancelReset
  }
}
