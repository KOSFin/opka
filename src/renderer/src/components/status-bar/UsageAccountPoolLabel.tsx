import { translate } from '@/i18n/i18n'
import type { AccountPoolView } from '../../../../shared/account-pool-view'
import { usageAccountPoolMembership } from './usage-account-pool-membership'

export function UsageAccountPoolLabel({
  view,
  verified,
  provider,
  accountId
}: {
  view: AccountPoolView | null
  verified: boolean
  provider: 'claude' | 'codex'
  accountId: string | null
}): React.JSX.Element {
  const membership =
    accountId && view ? usageAccountPoolMembership(view, provider, accountId) : null
  const member = membership?.member
  const selectionReason =
    verified && accountId
      ? view?.assignments.findLast(
          (entry) =>
            entry.provider === provider &&
            entry.accountId === accountId &&
            entry.poolId === membership?.policyId
        )?.selectionReason
      : null
  return (
    <p className="text-3xs text-muted-foreground">
      {accountId === null
        ? translate('usage.accounts.outsidePool', 'CLI login · outside pool')
        : !membership
          ? translate('usage.accounts.poolUnknown', 'Pool status unavailable')
          : [
              membership.mode === 'off'
                ? translate('usage.accounts.poolOff', 'Pool off')
                : membership.mode === 'manual'
                  ? translate('usage.accounts.poolManual', 'Pool · manual selection')
                  : membership.mode === 'sequential'
                    ? translate('usage.accounts.poolSequential', 'Pool · sequential')
                    : membership.mode === 'quota-equalize'
                      ? translate('usage.accounts.poolEqualize', 'Pool · equalize quota usage')
                      : translate('usage.accounts.poolBalanced', 'Pool · balanced'),
              !member
                ? translate('usage.accounts.poolExcluded', 'Excluded')
                : member.state === 'disabled'
                  ? translate('usage.accounts.poolDisabled', 'Disabled')
                  : member.state === 'draining'
                    ? translate('usage.accounts.poolDraining', 'Draining')
                    : member.role === 'reserve'
                      ? translate('usage.accounts.poolReserve', 'Reserve')
                      : member.role === 'manual'
                        ? translate('usage.accounts.poolManualOnly', 'Manual only')
                        : translate('usage.accounts.poolPrimary', 'Primary'),
              member
                ? translate('usage.accounts.poolPriority', 'Priority {{priority}}', {
                    priority: member.priority
                  })
                : null,
              member && membership.mode === 'balanced'
                ? translate('usage.accounts.poolWeight', 'Weight {{weight}}', {
                    weight: member.weight
                  })
                : null,
              membership.assignments
                ? translate('usage.accounts.poolAssignments', '{{count}} assigned', {
                    count: membership.assignments
                  })
                : null,
              membership.mode === 'quota-equalize' ? selectionReason : null,
              !verified
                ? translate('usage.accounts.poolLastKnown', 'Last known pool settings')
                : null
            ]
              .filter(Boolean)
              .join(' · ')}
    </p>
  )
}
