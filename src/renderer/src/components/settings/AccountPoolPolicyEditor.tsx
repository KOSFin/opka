import { Fragment, type ReactNode } from 'react'
import type { AccountPoolPolicy } from '../../../../shared/account-pool-policy'
import { ACCOUNT_POOL_EQUALIZE_CAPABILITY } from '../../../../shared/account-pool-policy'
import type { AccountPoolView } from '../../../../shared/account-pool-view'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  accountPoolDrafts,
  accountPoolStatus,
  setPoolMembership
} from '../../../../shared/account-pool-view'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AccountPoolMemberSettings } from './AccountPoolMemberSettings'
import { AccountPoolLaunchSettings } from './AccountPoolLaunchSettings'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  NativePoolRoutingScope,
  NativePoolConnection,
  NativePoolRoutingNotice
} from './NativePoolRoutingScope'

export type AccountPoolPresentation = {
  renderAccount?: (accountId: string, controls: ReactNode, automatic: boolean) => ReactNode
  beforeAccounts?: (automatic: boolean) => ReactNode
  accountIds?: readonly string[]
}

type Props = AccountPoolPresentation & {
  view: AccountPoolView
  policy: AccountPoolPolicy
  target: RuntimeClientTarget
  hostLabel: string
  busy: boolean
  saved: string | null
  saveError: { provider: string; message: string } | null
  change: (policy: AccountPoolPolicy) => void
  save: (policy: AccountPoolPolicy) => Promise<void>
}

export function AccountPoolPolicyEditor({
  view,
  policy,
  target,
  hostLabel,
  busy,
  saved,
  saveError,
  change,
  save,
  renderAccount,
  beforeAccounts,
  accountIds
}: Props): React.JSX.Element {
  const automatic = policy.applyToNewWork && policy.strategy !== 'manual'
  const appliedPolicy = view.policies.find((entry) => entry.id === policy.id)
  const manualBlocked =
    automatic || Boolean(appliedPolicy?.applyToNewWork && appliedPolicy.strategy !== 'manual')
  const unsaved =
    JSON.stringify(policy) !==
    JSON.stringify(accountPoolDrafts(view).find((entry) => entry.id === policy.id))
  return (
    <NativePoolRoutingScope
      target={target}
      hostLabel={hostLabel}
      enabled
      provider={policy.provider}
    >
      <div className="space-y-3 pb-3">
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.accountPools.systemLoginExplanation',
            "Saved accounts can join this pool. The agent's existing login stays available for manual use; save a separate account to include it in automatic selection."
          )}
        </p>
        <p className="text-sm font-medium">
          {automatic ? 'Selection mode: Automatic pool' : 'Selection mode: Specific account'}
        </p>
        <AccountPoolLaunchSettings policy={policy} disabled={busy} onChange={change} />
        {automatic ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select
              value={policy.strategy === 'manual' ? 'sequential' : policy.strategy}
              disabled={busy}
              onValueChange={(strategy) => {
                if (
                  strategy === 'manual' ||
                  strategy === 'sequential' ||
                  strategy === 'balanced' ||
                  (strategy === 'quota-equalize' &&
                    policy.provider === 'codex' &&
                    view.equalizeCapability === ACCOUNT_POOL_EQUALIZE_CAPABILITY)
                ) {
                  change({ ...policy, strategy })
                }
              }}
            >
              <SelectTrigger aria-label={`${policy.provider} pool mode`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sequential">Sequential</SelectItem>
                <SelectItem value="balanced">Balanced</SelectItem>
                {policy.provider === 'codex' &&
                view.equalizeCapability === ACCOUNT_POOL_EQUALIZE_CAPABILITY ? (
                  <SelectItem value="quota-equalize">Equalize quota usage</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {automatic && policy.strategy === 'quota-equalize' ? (
          <p className="text-xs text-muted-foreground">
            Uses fresh comparable quota windows. Rechecks only between settled turns; near equal
            usage keeps the current account.
          </p>
        ) : null}
        <NativePoolRoutingNotice />
        {automatic ? (
          <details>
            <summary className="cursor-pointer text-xs font-medium">
              {translate('settings.accountPools.advancedEligibility', 'Advanced eligibility')}
            </summary>
            <div className="space-y-3 pt-3">
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
            </div>
          </details>
        ) : null}
        {view.accounts[policy.provider].accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No managed accounts on this host. Add an account in the provider settings.
          </p>
        ) : null}
        {beforeAccounts?.(manualBlocked)}
        {view.accounts[policy.provider].accounts
          .filter((account) => !accountIds || accountIds.includes(account.id))
          .map((account) => {
            const member = policy.members.find((entry) => entry.accountId === account.id)
            const usedPercent = view.candidates.find(
              (entry) => entry.provider === policy.provider && entry.accountId === account.id
            )?.usedPercent
            const controls = (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">
                  {accountPoolStatus(view, policy, account.id)}
                  {usedPercent != null ? ` · ${usedPercent}% used` : ''}
                </p>
                <NativePoolConnection
                  target={target}
                  hostLabel={hostLabel}
                  accountId={account.id}
                />
                {automatic ? (
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
                ) : null}
              </div>
            )
            return renderAccount ? (
              <Fragment key={account.id}>
                {renderAccount(account.id, controls, manualBlocked)}
              </Fragment>
            ) : (
              <div key={account.id} className="space-y-2 border-t border-border pt-3">
                <p className="break-words text-sm font-medium">
                  {account.email}
                  {view.accounts[policy.provider].activeAccountId === account.id
                    ? ' · Manual default'
                    : ''}
                </p>
                {controls}
              </div>
            )
          })}
        {saveError?.provider === policy.provider ? (
          <p role="alert" className="text-xs text-destructive">
            {saveError.message}
          </p>
        ) : null}
        {saved === policy.provider ? (
          <p role="status" className="text-xs text-muted-foreground">
            {policy.provider === 'codex' ? 'Codex' : 'Claude'} pool saved on {hostLabel}.
          </p>
        ) : null}
        {unsaved ? (
          <p className="text-xs text-muted-foreground">Unsaved changes. Save to apply.</p>
        ) : null}
        <Button size="sm" disabled={busy} onClick={() => void save(policy)}>
          {renderAccount
            ? `Save ${policy.provider === 'codex' ? 'Codex' : 'Claude'} settings`
            : `Save ${policy.provider} pool`}
        </Button>
      </div>
    </NativePoolRoutingScope>
  )
}
