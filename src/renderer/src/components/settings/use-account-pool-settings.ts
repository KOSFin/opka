import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AccountPoolPolicy } from '../../../../shared/account-pool-policy'
import { AccountPoolViewSchema, accountPoolDrafts } from '../../../../shared/account-pool-view'
import type { AccountPoolView } from '../../../../shared/account-pool-view'
import { invalidateUsageAccountPools } from '../status-bar/usage-account-pool-cache'

function mergeAccountPoolDrafts(
  view: AccountPoolView,
  previous: AccountPoolPolicy[],
  dirty: ReadonlySet<string>
): AccountPoolPolicy[] {
  return accountPoolDrafts({
    ...view,
    policies: accountPoolDrafts(view).map((policy) =>
      dirty.has(policy.id)
        ? (previous.find((entry) => entry.id === policy.id && entry.provider === policy.provider) ??
          policy)
        : policy
    )
  })
}

function unsupportedAccountPools(cause: unknown): boolean {
  return cause instanceof RuntimeRpcCallError && cause.code === 'unknown_method'
}

export function useAccountPoolSettings(target: RuntimeClientTarget, refreshKey?: string) {
  const dirty = useRef(new Set<string>())
  const readSequence = useRef(0)
  const previousProjection = useRef(refreshKey)
  const [view, setView] = useState<AccountPoolView | null>(null)
  const [drafts, setDrafts] = useState<AccountPoolPolicy[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ provider: string; message: string } | null>(null)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [viewOwner, setViewOwner] = useState(environmentId)
  const ownerRef = useRef({ id: environmentId, revision: 0 })
  if (ownerRef.current.id !== environmentId) {
    ownerRef.current = { id: environmentId, revision: ownerRef.current.revision + 1 }
  }
  useEffect(() => {
    dirty.current.clear()
    const sequence = ++readSequence.current
    setView(null)
    setDrafts([])
    setSaved(null)
    setSaveError(null)
    setError(null)
    setUnsupported(false)
    setBusy(false)
    const controller = new AbortController()
    const requestTarget: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    void callRuntimeRpc<unknown>(requestTarget, 'accountPool.list', undefined, {
      signal: controller.signal
    })
      .then((result) => {
        if (controller.signal.aborted || sequence !== readSequence.current) {
          return
        }
        const next = AccountPoolViewSchema.parse(result)
        setView(next)
        setUnsupported(false)
        setError(null)
        setDrafts(accountPoolDrafts(next))
        setViewOwner(environmentId)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && sequence === readSequence.current) {
          setUnsupported(unsupportedAccountPools(cause))
          setError(String(cause instanceof Error ? cause.message : cause))
          setViewOwner(environmentId)
        }
      })
    return () => controller.abort()
  }, [environmentId])
  useEffect(() => {
    if (busy || previousProjection.current === refreshKey) {
      return
    }
    previousProjection.current = refreshKey
    const revision = ownerRef.current.revision
    const sequence = ++readSequence.current
    const controller = new AbortController()
    const requestTarget: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    void callRuntimeRpc(requestTarget, 'accountPool.list', undefined, { signal: controller.signal })
      .then((result) => {
        if (
          controller.signal.aborted ||
          ownerRef.current.revision !== revision ||
          sequence !== readSequence.current
        ) {
          return
        }
        const next = AccountPoolViewSchema.parse(result)
        setView(next)
        setUnsupported(false)
        setError(null)
        setViewOwner(environmentId)
        setDrafts((previous) => mergeAccountPoolDrafts(next, previous, dirty.current))
      })
      .catch((cause: unknown) => {
        if (
          !controller.signal.aborted &&
          ownerRef.current.revision === revision &&
          sequence === readSequence.current
        ) {
          const unsupported = unsupportedAccountPools(cause)
          setUnsupported(unsupported)
          if (unsupported) {
            setView(null)
            setDrafts([])
          }
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => controller.abort()
  }, [environmentId, refreshKey, busy])
  function change(policy: AccountPoolPolicy): void {
    dirty.current.add(policy.id)
    setDrafts((previous) => previous.map((entry) => (entry.id === policy.id ? policy : entry)))
    setSaved((previous) => (previous === policy.provider ? null : previous))
    setSaveError((previous) => (previous?.provider === policy.provider ? null : previous))
  }
  async function refresh(): Promise<void> {
    if (busy) {
      return
    }
    const revision = ownerRef.current.revision
    const sequence = ++readSequence.current
    setBusy(true)
    setSaved(null)
    setError(null)
    try {
      await callRuntimeRpc(target, 'accounts.list', { refreshUsage: true })
      invalidateUsageAccountPools(target)
      const next = AccountPoolViewSchema.parse(await callRuntimeRpc(target, 'accountPool.list'))
      if (ownerRef.current.revision !== revision || sequence !== readSequence.current) {
        return
      }
      setView(next)
      setUnsupported(false)
      setError(null)
      setDrafts((previous) => mergeAccountPoolDrafts(next, previous, dirty.current))
      setSaveError(null)
    } catch (cause) {
      if (ownerRef.current.revision === revision) {
        const unsupported = unsupportedAccountPools(cause)
        setUnsupported(unsupported)
        if (unsupported) {
          setView(null)
          setDrafts([])
        }
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (ownerRef.current.revision === revision) {
        setBusy(false)
      }
    }
  }
  async function save(policy: AccountPoolPolicy): Promise<void> {
    const revision = ownerRef.current.revision
    if (busy) {
      return
    }
    ++readSequence.current
    setBusy(true)
    setSaved(null)
    setSaveError(null)
    try {
      await callRuntimeRpc(target, 'accountPool.update', {
        policy,
        expectedRevision: policy.revision
      })
      invalidateUsageAccountPools(target)
      if (ownerRef.current.revision !== revision) {
        return
      }
      const sequence = ++readSequence.current
      const next = AccountPoolViewSchema.parse(await callRuntimeRpc(target, 'accountPool.list'))
      if (ownerRef.current.revision !== revision || sequence !== readSequence.current) {
        return
      }
      setView(next)
      setUnsupported(false)
      setError(null)
      setDrafts((previous) =>
        previous.map((entry) =>
          entry.id === policy.id
            ? (next.policies.find((savedPolicy) => savedPolicy.id === policy.id) ?? entry)
            : entry
        )
      )
      dirty.current.delete(policy.id)
      setSaved(policy.provider)
    } catch (cause) {
      if (ownerRef.current.revision === revision) {
        setSaveError({
          provider: policy.provider,
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    } finally {
      if (ownerRef.current.revision === revision) {
        setBusy(false)
      }
    }
  }
  const current = viewOwner === environmentId
  return {
    unsupported: current && unsupported,
    view: current ? view : null,
    drafts: current ? drafts : [],
    busy: current && busy,
    error: current ? error : null,
    saved: current ? saved : null,
    saveError: current ? saveError : null,
    change,
    refresh,
    save
  }
}
