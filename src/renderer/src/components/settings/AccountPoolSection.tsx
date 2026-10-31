import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AccountPoolPolicy } from '../../../../shared/account-pool-policy'
import {
  AccountPoolViewSchema,
  accountPoolDrafts,
  accountPoolStatus,
  setPoolMembership
} from '../../../../shared/account-pool-view'
import type { AccountPoolView } from '../../../../shared/account-pool-view'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AccountPoolMemberSettings } from './AccountPoolMemberSettings'
import { AccountPoolLaunchSettings } from './AccountPoolLaunchSettings'
import { SettingsSwitchRow } from './SettingsFormControls'

export function AccountPoolSection({
  target,
  hostLabel
}: {
  target: RuntimeClientTarget
  hostLabel: string
}): React.JSX.Element {
  const [view, setView] = useState<AccountPoolView | null>(null)
  const [drafts, setDrafts] = useState<AccountPoolPolicy[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  useEffect(() => {
    const controller = new AbortController()
    const requestTarget: RuntimeClientTarget = environmentId
      ? { kind: 'environment', environmentId }
      : { kind: 'local' }
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
    setSaved(false)
  }
  async function refresh(): Promise<void> {
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      const next = AccountPoolViewSchema.parse(await callRuntimeRpc(target, 'accountPool.list'))
      setView(next)
      setDrafts(accountPoolDrafts(next))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  async function save(policy: AccountPoolPolicy): Promise<void> {
    if (busy) {
      return
    }
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      await callRuntimeRpc(target, 'accountPool.update', {
        policy,
        expectedRevision: policy.revision
      })
      const next = AccountPoolViewSchema.parse(await callRuntimeRpc(target, 'accountPool.list'))
      setView(next)
      setDrafts((previous) =>
        previous.map((entry) =>
          entry.id === policy.id
            ? (next.policies.find((savedPolicy) => savedPolicy.id === policy.id) ?? entry)
            : entry
        )
      )
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section id="account-pools" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate('settings.accountPools.title', 'Account pools')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.accountPools.scope',
            'Execution host: {{host}}. Pools apply only to managed launches on this host. Automatic switching waits for a supported, completed turn.',
            { host: hostLabel }
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.accountPools.modes',
            'Manual pauses automatic selection. Sequential uses the lowest priority number first. Balanced spreads launches across eligible accounts. Drain stops new assignments.'
          )}
        </p>
      </div>
      {error ? (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p>
            {view
              ? 'Could not save or refresh pools.'
              : 'Account pools unavailable on this host. An older host may require an update.'}{' '}
            {error}
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            Refresh pools
          </Button>
        </div>
      ) : null}
      {!view && !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading account pools…
        </p>
      ) : null}
      {view ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          Refresh pools
        </Button>
      ) : null}
      {view
        ? drafts.map((policy) => (
            <div key={policy.id} className="space-y-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="text-sm font-medium">
                  {policy.provider === 'claude' ? 'Claude' : 'Codex'} · {policy.id}
                </h4>
                <Select
                  value={policy.strategy}
                  disabled={busy}
                  onValueChange={(strategy) => {
                    if (
                      strategy === 'manual' ||
                      strategy === 'sequential' ||
                      strategy === 'balanced'
                    ) {
                      change({ ...policy, strategy })
                    }
                  }}
                >
                  <SelectTrigger aria-label={`${policy.provider} pool mode`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="sequential">Sequential</SelectItem>
                    <SelectItem value="balanced">Balanced</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <AccountPoolLaunchSettings policy={policy} disabled={busy} onChange={change} />
              <SettingsSwitchRow
                label="Allow accounts with unknown quota"
                description="Unknown quota does not prove that capacity is available."
                checked={policy.unknownQuota === 'allow'}
                disabled={busy}
                onChange={() =>
                  change({
                    ...policy,
                    unknownQuota: policy.unknownQuota === 'allow' ? 'exclude' : 'allow'
                  })
                }
              />
              <SettingsSwitchRow
                label="Allow reserve accounts"
                description="Use reserve accounts only when no primary account is eligible. Manual-only accounts are never selected automatically."
                checked={policy.allowReserve}
                disabled={busy}
                onChange={() => change({ ...policy, allowReserve: !policy.allowReserve })}
              />
              {view.accounts[policy.provider].accounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No managed accounts on this host. Add an account in the provider settings.
                </p>
              ) : null}
              {view.accounts[policy.provider].accounts.map((account) => {
                const member = policy.members.find((entry) => entry.accountId === account.id)
                return (
                  <div key={account.id} className="space-y-2 border-t border-border pt-3">
                    <p className="break-words text-sm font-medium">
                      {account.email}
                      {view.accounts[policy.provider].activeAccountId === account.id
                        ? ' · Selected login'
                        : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {accountPoolStatus(view, policy, account.id)}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <Select
                        value={member?.state ?? 'excluded'}
                        disabled={busy}
                        onValueChange={(state) => {
                          if (
                            state === 'enabled' ||
                            state === 'draining' ||
                            state === 'disabled' ||
                            state === 'excluded'
                          ) {
                            change(setPoolMembership(policy, account.id, state))
                          }
                        }}
                      >
                        <SelectTrigger aria-label={`${account.email} pool participation`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="excluded">Excluded</SelectItem>
                          <SelectItem value="enabled">Included</SelectItem>
                          <SelectItem value="draining">Drain</SelectItem>
                          <SelectItem value="disabled">Disabled</SelectItem>
                        </SelectContent>
                      </Select>
                      {member ? (
                        <AccountPoolMemberSettings
                          member={member}
                          accountLabel={account.email}
                          balanced={policy.strategy === 'balanced'}
                          disabled={busy}
                          onChange={(next) =>
                            change({
                              ...policy,
                              members: policy.members.map((entry) =>
                                entry.accountId === account.id ? next : entry
                              )
                            })
                          }
                        />
                      ) : null}
                    </div>
                  </div>
                )
              })}
              <Button size="sm" disabled={busy} onClick={() => void save(policy)}>
                Save {policy.provider} pool
              </Button>
            </div>
          ))
        : null}
      {saved ? (
        <p role="status" className="text-xs text-muted-foreground">
          Pool saved on {hostLabel}.
        </p>
      ) : null}
    </section>
  )
}
