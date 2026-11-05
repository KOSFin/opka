import { useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AccountPoolPolicy } from '../../../../shared/account-pool-policy'
import { AccountPoolViewSchema, accountPoolDrafts } from '../../../../shared/account-pool-view'
import type { AccountPoolView } from '../../../../shared/account-pool-view'

export function useAccountPoolSettings(target: RuntimeClientTarget) {
  const [view, setView] = useState<AccountPoolView | null>(null)
  const [drafts, setDrafts] = useState<AccountPoolPolicy[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ provider: string; message: string } | null>(null)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [viewOwner, setViewOwner] = useState(environmentId)
  const ownerRef = useRef({ id: environmentId, revision: 0 })
  if (ownerRef.current.id !== environmentId) {
    ownerRef.current = { id: environmentId, revision: ownerRef.current.revision + 1 }
  }
  useEffect(() => {
    setView(null)
    setDrafts([])
    setSaved(null)
    setSaveError(null)
    setError(null)
    setBusy(false)
    setViewOwner(environmentId)
    const controller = new AbortController()
    const requestTarget: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    void callRuntimeRpc<unknown>(requestTarget, 'accountPool.list', undefined, {
      signal: controller.signal
    })
      .then((result) => {
        if (controller.signal.aborted) {
          return
        }
        const next = AccountPoolViewSchema.parse(result)
        setView(next)
        setDrafts(accountPoolDrafts(next))
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(String(cause instanceof Error ? cause.message : cause))
        }
      })
    return () => controller.abort()
  }, [environmentId])
  function change(policy: AccountPoolPolicy): void {
    setDrafts((previous) => previous.map((entry) => (entry.id === policy.id ? policy : entry)))
    setSaved((previous) => (previous === policy.provider ? null : previous))
    setSaveError((previous) => (previous?.provider === policy.provider ? null : previous))
  }
  async function refresh(): Promise<void> {
    const revision = ownerRef.current.revision
    setBusy(true)
    setSaved(null)
    setError(null)
    try {
      const next = AccountPoolViewSchema.parse(await callRuntimeRpc(target, 'accountPool.list'))
      if (ownerRef.current.revision !== revision) {
        return
      }
      setView(next)
      setDrafts(accountPoolDrafts(next))
      setSaveError(null)
    } catch (cause) {
      if (ownerRef.current.revision === revision) {
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
    setBusy(true)
    setSaved(null)
    setSaveError(null)
    try {
      await callRuntimeRpc(target, 'accountPool.update', {
        policy,
        expectedRevision: policy.revision
      })
      if (ownerRef.current.revision !== revision) {
        return
      }
      const next = AccountPoolViewSchema.parse(await callRuntimeRpc(target, 'accountPool.list'))
      if (ownerRef.current.revision !== revision) {
        return
      }
      setView(next)
      setDrafts((previous) =>
        previous.map((entry) =>
          entry.id === policy.id
            ? (next.policies.find((savedPolicy) => savedPolicy.id === policy.id) ?? entry)
            : entry
        )
      )
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
